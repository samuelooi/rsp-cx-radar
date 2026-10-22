/**
 * Model warnings: problems in how a file was exported that will make it fail
 * CORENET X submission, or that the authority's checker will trip over, before
 * any IFC-SG property is looked at.
 *
 * Everything here reads what the app already holds after loading — the
 * per-model indexes, the file identities and where the viewer found geometry —
 * so it costs nothing to rerun and never touches the (released) wasm model.
 *
 * Two levels:
 *  - `fail`: the submission will be rejected or a gateway check cannot run.
 *  - `warn`: likely wrong; worth checking before submitting.
 */

import { withinSvy21Bounds } from './geo/svy21.js';

/** Geometry this far from the file's own origin loses precision in float32 viewers and checkers. */
const ORIGIN_FAR_M = 5000;
/** Two files whose map conversions differ by more than this are not on the same datum. */
const DATUM_TOLERANCE_M = 0.01;
const DATUM_TOLERANCE_DEG = 0.001;
/** Same storey name in two files at elevations further apart than this. */
const STOREY_TOLERANCE_MM = 10;
const SPATIAL = new Set(['IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE']);

const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const isCrsSvy21 = (crs) => /3414|SVY21|SVY 21/i.test(
  [crs && crs.name, crs && crs.geodeticDatum, crs && crs.mapProjection].filter(Boolean).join(' '));

/**
 * @param {object} input
 * @param {Map<number, object>} input.indexes      modelID -> per-model index (ifc-index.js)
 * @param {Map<number, object>} input.identities   modelID -> identity (model-id.js)
 * @param {Map<number, string>} input.names        modelID -> file name
 * @param {Array<{modelID, expressID, distance}>} [input.far]  elements the viewer left out of the framing
 * @param {Map<number, {x, y, z}>} [input.centres]  modelID -> geometry centre in IFC metres
 * @returns {Array<{id: string, severity: 'fail'|'warn', title: string, detail: string,
 *                  file: string|null, elements: object[]}>}
 */
export function computeWarnings({ indexes, identities, names, far = [], centres = new Map() }) {
  const out = [];
  const add = (severity, id, title, detail, { file = null, elements = [] } = {}) =>
    out.push({ id, severity, title, detail, file, elements });
  const multi = indexes.size > 1;

  for (const [modelID, idx] of indexes) {
    const file = names.get(modelID) || `Model ${modelID}`;
    const identity = identities.get(modelID) || {};
    const georef = idx.georef || {};
    const on = { file };

    // ---- schema
    const schema = identity.schema;
    if (schema && !/^IFC4$/i.test(schema)) {
      add('fail', `schema:${modelID}`, `Exported as ${schema}, not IFC4`,
        'CORENET X takes IFC4 (Reference View) files. Re-export with the IFC4 schema; ' +
        'IFC2x3 and IFC4x3 files are not accepted for IFC-SG.', on);
    }

    // ---- spatial structure
    const sites = (idx.byEntity.get('IFCSITE') || []);
    const nSites = Math.max(sites.length, (idx.spatial && idx.spatial.sites.length) || 0);
    if (nSites === 0) {
      add('fail', `site-none:${modelID}`, 'No IfcSite',
        'Every IFC-SG file needs exactly one IfcSite: it carries the site\'s location and ' +
        'the building sits under it. Check the export\'s spatial structure.', on);
    } else if (nSites > 1) {
      add('fail', `site-multi:${modelID}`, `${nSites} IfcSite entities in one file`,
        'A file must have exactly one IfcSite. A second one usually comes in with a linked ' +
        'model exported into the same file, or a site copied from another project. Keep one ' +
        'site and move everything under it.',
        { ...on, elements: sites });
    }

    const buildings = idx.byEntity.get('IFCBUILDING') || [];
    const nBuildings = Math.max(buildings.length, (idx.spatial && idx.spatial.buildings.length) || 0);
    if (nBuildings === 0) {
      add('fail', `bldg-none:${modelID}`, 'No IfcBuilding',
        'Storeys and elements must sit under an IfcBuilding. Without one, the storeys and ' +
        'gross floor area cannot be read.', on);
    } else if (nBuildings > 1) {
      add('warn', `bldg-multi:${modelID}`, `${nBuildings} IfcBuilding entities in one file`,
        'Most submissions have one building per file. Check that the extra building is ' +
        'intended and not left over from a linked or copied model.', { ...on, elements: buildings });
    }

    const storeys = idx.storeys || [];
    if (!storeys.length) {
      add('fail', `storey-none:${modelID}`, 'No building storeys',
        'Elements must be contained in an IfcBuildingStorey. Without storeys, levels, ' +
        'floor areas and storey-based checks cannot run.', on);
    } else {
      const byName = new Map();
      for (const s of storeys) {
        const k = String(s.name || '').trim();
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(s);
      }
      const dupes = [...byName].filter(([, list]) => list.length > 1);
      if (dupes.length) {
        add('warn', `storey-dupe:${modelID}`,
          `${plural(dupes.length, 'storey name')} used more than once`,
          `Storey names must be unique in a file: ${dupes.map(([n, l]) => `"${n || '(blank)'}" ×${l.length}`).join(', ')}. ` +
          'Elements and areas reported by level will be merged or split wrongly.', on);
      }
      const blank = storeys.filter((s) => !String(s.name || '').trim());
      if (blank.length) {
        add('warn', `storey-blank:${modelID}`, `${plural(blank.length, 'storey')} without a name`,
          'Every storey needs a name, which is how the authorities refer to levels.', on);
      }
    }

    // ---- georeferencing
    const mc = georef.mapConversion;
    if (!mc) {
      add('fail', `geo-none:${modelID}`, 'Not georeferenced (no IfcMapConversion)',
        'CORENET X places the model on the ground with IfcMapConversion and an SVY21 ' +
        'IfcProjectedCRS. In Revit\'s IFC export, set the coordinate base to Shared Coordinates ' +
        'and the EPSG code to 3414 so the map conversion is written.', on);
    } else {
      if (!georef.crs) {
        add('fail', `crs-none:${modelID}`, 'No IfcProjectedCRS',
          'The map conversion has no projected CRS, so the offset has no named coordinate ' +
          'system. It should name SVY21 (EPSG:3414).', on);
      } else if (!isCrsSvy21(georef.crs)) {
        add('fail', `crs-other:${modelID}`, `Coordinate system is "${georef.crs.name || '(unnamed)'}", not SVY21`,
          'Singapore submissions use SVY21 (EPSG:3414). Set the projected CRS name to EPSG:3414.', on);
      }

      const eff = (mc.scale || 1) / (georef.metresPerUnit || 1);
      if (Math.abs(eff - 1) > 1e-6) {
        add('warn', `geo-scale:${modelID}`, `Map conversion scale is ${mc.scale}`,
          `With the file in ${georef.lengthUnitName || 'its unit'}, this scales the model ×${+eff.toPrecision(4)} ` +
          'on the map. The scale should convert the file\'s length unit to metres and nothing more ' +
          `(${georef.metresPerUnit === 0.001 ? '0.001 for millimetres' : 'e.g. 0.001 for millimetres'}).`, on);
      }

      const c = centres.get(modelID);
      if (c) {
        const cos = Math.cos(mc.rotation);
        const sin = Math.sin(mc.rotation);
        const E = mc.eastings + eff * (c.x * cos - c.y * sin);
        const N = mc.northings + eff * (c.x * sin + c.y * cos);
        if (!withinSvy21Bounds(E, N)) {
          add('fail', `geo-out:${modelID}`, 'Model is placed outside Singapore',
            `With its map conversion, the model sits at E ${Math.round(E)}, N ${Math.round(N)}, outside ` +
            'the SVY21 grid. Usually the survey offset is applied twice: the geometry is already in ' +
            'survey coordinates and the map conversion adds the offset again. Export relative to the ' +
            'project base point, or set the map conversion offset to zero.', on);
        }
      } else if (!withinSvy21Bounds(mc.eastings, mc.northings)) {
        add('fail', `geo-out:${modelID}`, 'Map origin is outside Singapore',
          `The map conversion puts the file's origin at E ${Math.round(mc.eastings)}, N ${Math.round(mc.northings)}, ` +
          'outside the SVY21 grid.', on);
      }
    }

    // ---- geometry far from the file's own origin
    const c = centres.get(modelID);
    if (c) {
      const d = Math.hypot(c.x, c.y);
      if (d > ORIGIN_FAR_M) {
        add('warn', `origin-far:${modelID}`, `Geometry is ${dist(d)} from the file's origin`,
          'The building is modelled far from its own (0,0,0). Coordinates this large lose precision ' +
          'and can make thin elements and space boundaries fail geometry checks. Keep the geometry ' +
          'near the origin and carry the survey offset in the map conversion.', on);
      }
    }

    // ---- elements
    const elements = idx.all || [];

    const userDefinedBlank = elements.filter((e) =>
      String(e.predefinedType || '').toUpperCase() === 'USERDEFINED' && !String(e.objectType || '').trim());
    if (userDefinedBlank.length) {
      add('fail', `ud-blank:${modelID}`,
        `${plural(userDefinedBlank.length, 'element')} USERDEFINED with no ObjectType`,
        'PredefinedType USERDEFINED means the subtype is written in ObjectType. Left blank, the ' +
        'element has no IFC-SG subtype and every requirement for it is missed.',
        { ...on, elements: userDefinedBlank });
    }

    const proxies = elements.filter((e) => e.canonicalEntity === 'IFCBUILDINGELEMENTPROXY');
    const looseProxies = proxies.filter((e) => !String(e.objectType || '').trim() &&
      String(e.predefinedType || '').toUpperCase() !== 'USERDEFINED');
    if (looseProxies.length) {
      add('warn', `proxy:${modelID}`, `${plural(looseProxies.length, 'IfcBuildingElementProxy', 'IfcBuildingElementProxies')} with no subtype`,
        'Proxies are only accepted for the IFC-SG components mapped to them, identified by ' +
        'ObjectType. These have none: map their category to a proper IFC class, or set ' +
        'IfcExportAs / ObjectType.', { ...on, elements: looseProxies });
    }

    const noStorey = elements.filter((e) => !SPATIAL.has(e.canonicalEntity) && !e.storey && !e.hostKey);
    if (noStorey.length && storeys.length) {
      add('warn', `no-storey:${modelID}`, `${plural(noStorey.length, 'element')} not on any storey`,
        'These are not contained in a building storey, so they are left out of anything ' +
        'reported by level. Usually they are hosted to a reference level that was not exported ' +
        'as a storey; external works placed on the site are expected here.', { ...on, elements: noStorey });
    }

    const spaces = idx.byEntity.get('IFCSPACE') || [];
    const flatSpaces = spaces.filter((e) => !e.hasGeometry);
    if (flatSpaces.length) {
      add('fail', `space-geom:${modelID}`, `${plural(flatSpaces.length, 'IfcSpace')} with no geometry`,
        'Area and space checks measure the space\'s solid. An unplaced or unbounded room ' +
        'exports with no shape: place it, close its boundary, or delete it.',
        { ...on, elements: flatSpaces });
    }

    const spaceNoStorey = spaces.filter((e) => !e.storey);
    if (spaceNoStorey.length && storeys.length) {
      add('warn', `space-storey:${modelID}`, `${plural(spaceNoStorey.length, 'IfcSpace')} not under a storey`,
        'Spaces must decompose from a building storey to be counted in that level\'s area.',
        { ...on, elements: spaceNoStorey });
    }

    // ---- GlobalIds within a file
    const seen = new Map();
    for (const e of elements) {
      if (!e.globalId) continue;
      if (!seen.has(e.globalId)) seen.set(e.globalId, []);
      seen.get(e.globalId).push(e);
    }
    const dupGuids = [...seen.values()].filter((l) => l.length > 1);
    if (dupGuids.length) {
      add('fail', `guid-dupe:${modelID}`, `${plural(dupGuids.length, 'GlobalId')} shared by more than one element`,
        'Every element needs its own GlobalId; the authority\'s checker and BCF issues address ' +
        'elements by it. Duplicates come from copied elements in some exporters or from merging files.',
        { ...on, elements: dupGuids.flat() });
    }

    const noGuid = elements.filter((e) => !e.globalId);
    if (noGuid.length) {
      add('fail', `guid-none:${modelID}`, `${plural(noGuid.length, 'element')} without a GlobalId`,
        'GlobalId is mandatory on every IFC element.', { ...on, elements: noGuid });
    }

    // ---- file size
    const mb = (identity.bytes || 0) / 1048576;
    if (mb > 500) {
      add('warn', `size:${modelID}`, `Large file (${Math.round(mb)} MB)`,
        'Large files are slow to upload and check, and may exceed the portal\'s size limit. ' +
        'Consider splitting by discipline or zone, or leaving out linked models and detail ' +
        'families not needed for the submission.', on);
    }
  }

  // ---- stray geometry, from what the viewer left out of the framing
  if (far.length) {
    const byModel = new Map();
    for (const f of far) {
      if (!indexes.has(f.modelID) && !names.has(f.modelID)) continue;
      if (!byModel.has(f.modelID)) byModel.set(f.modelID, []);
      byModel.get(f.modelID).push(f);
    }
    for (const [modelID, list] of byModel) {
      const idx = indexes.get(modelID);
      const elements = list.map((f) => {
        const known = idx && idx.byId.get(`${modelID}:${f.expressID}`);
        const base = known || {
          modelID, expressID: f.expressID, key: `${modelID}:${f.expressID}`,
          entity: 'Element', name: `#${f.expressID}`, parts: [], bare: true,
        };
        return { ...base, distance: f.distance };
      });
      add('fail', `far:${modelID}`,
        `${plural(list.length, 'element')} far from the rest of the model`,
        `Up to ${dist(list[0].distance)} away from the building. Stray geometry (a lost family, ` +
        'a detail left at the internal origin, an element in survey rather than shared ' +
        'coordinates) stretches the model\'s extents and breaks georeferencing and site checks. ' +
        'Delete or move them.', { file: names.get(modelID) || `Model ${modelID}`, elements });
    }
  }

  // ---- across files
  if (multi) {
    const list = [...indexes.entries()];
    const [firstID, first] = list[0];
    const fmc = first.georef && first.georef.mapConversion;
    if (fmc) {
      const differ = list.slice(1).filter(([, idx]) => {
        const m = idx.georef && idx.georef.mapConversion;
        if (!m) return false;
        const sf = (first.georef.metresPerUnit || 1);
        const so = (idx.georef.metresPerUnit || 1);
        return Math.abs(m.eastings - fmc.eastings) > DATUM_TOLERANCE_M ||
          Math.abs(m.northings - fmc.northings) > DATUM_TOLERANCE_M ||
          Math.abs(m.orthogonalHeight - fmc.orthogonalHeight) > DATUM_TOLERANCE_M ||
          Math.abs((m.rotation - fmc.rotation) * 180 / Math.PI) > DATUM_TOLERANCE_DEG ||
          Math.abs(m.scale / so - fmc.scale / sf) > 1e-6;
      });
      if (differ.length) {
        add('warn', 'datum', `${plural(differ.length, 'file')} on a different survey datum`,
          `${differ.map(([id]) => names.get(id)).join(', ')} ${differ.length === 1 ? 'has' : 'have'} a map ` +
          `conversion that differs from ${names.get(firstID)}'s. Files in one submission should share ` +
          'the same shared coordinates, or they will not line up in the authority\'s federated view.');
      }
    }

    // Same storey name at different heights in different files.
    const byName = new Map();
    for (const [modelID, idx] of list) {
      for (const s of idx.storeys || []) {
        const k = String(s.name || '').trim().toLowerCase();
        if (!k || s.elevation == null) continue;
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push({ modelID, s });
      }
    }
    const mismatched = [];
    for (const entries of byName.values()) {
      const models = new Set(entries.map((e) => e.modelID));
      if (models.size < 2) continue;
      const els = entries.map((e) => e.s.elevation);
      if (Math.max(...els) - Math.min(...els) > STOREY_TOLERANCE_MM) mismatched.push(entries);
    }
    if (mismatched.length) {
      add('warn', 'storey-align', `${plural(mismatched.length, 'storey')} at different heights in different files`,
        mismatched.slice(0, 6).map((entries) => `"${entries[0].s.name}": ` +
          entries.map((e) => `${names.get(e.modelID)} ${Math.round(e.s.elevation)} mm`).join(', ')).join('; ') +
        (mismatched.length > 6 ? '; …' : '') +
        '. Levels with the same name should be at the same elevation across disciplines.');
    }

    // The same element in two files.
    const owner = new Map();
    const shared = [];
    for (const [modelID, idx] of list) {
      for (const e of idx.all || []) {
        if (!e.globalId || SPATIAL.has(e.canonicalEntity)) continue;
        const prev = owner.get(e.globalId);
        if (prev && prev.modelID !== modelID) shared.push(prev, e);
        else if (!prev) owner.set(e.globalId, e);
      }
    }
    if (shared.length) {
      const n = new Set(shared.map((e) => e.globalId)).size;
      add('warn', 'guid-cross', `${plural(n, 'element')} ${n === 1 ? 'appears' : 'appear'} in more than one file`,
        'The same GlobalId is in two loaded files. Either the same model is loaded twice, ' +
        'or elements were copied between discipline models and will be counted twice.',
        { elements: [...new Set(shared)] });
    }
  }

  const rank = { fail: 0, warn: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
