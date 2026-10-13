# Mapping review

Things found while splitting `data/ifcsg-rules.json` (from `industry-mapping-4-dec-2025139335b79c8943d695c7b84984c9d50b_gateway mapping.xlsx`, generated 2026-10-13T13:59:50+08:00) into the four tables: 124 element types, 251 properties, 39 value lists, 406 requirements.

Only the ARC and External Works rows are here: the build script leaves the other disciplines out of the ruleset.

Nothing below changes what the checker does today. Each item is a decision for you: fix the table, or leave it and delete the item.

## Read this first

- 8 rows (S/N 830, 831, 833, 834, 837, 832, 836, 835) say "all subtypes in COP". The checker has always treated that the same as no subtype, so they point at the bare entity (e.g. IfcWindow).

## Accepted values that disagree

- `SGPset_GeographicElement.Status`: Status on S/N 144; Status_GreenVerge on S/N 202; Status_Planting on S/N 258; Status_PlantingAreas on S/N 389. Default set to `Status`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_SpaceArea_Landscape.ALS_GreeneryFeatures`: ALS_GreeneryFeatures_AreaALS on S/N 203; ALS_GreeneryFeatures on S/N 670. Default set to `ALS_GreeneryFeatures`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_SpaceArea_Landscape.ALS_LandscapeType`: ALS_LandscapeType_AreaALS on S/N 204; ALS_LandscapeType on S/N 669. Default set to `ALS_LandscapeType`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_Space.SpaceName`: SpaceName_HouseholdShelter on S/N 219; SpaceName_Room on S/N 292; (no list) on S/N 462; SpaceName_RefuseChuteRecyclablesChute on S/N 528; SpaceName on S/N 697; SpaceName_Staircase on S/N 723; SpaceName_Tank on S/N 761. Default set to `SpaceName`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_Space.ConstructionMethod`: ConstructionMethod on S/N 220, 529; ConstructionMethod_PrefabSpace on S/N 465. Default set to `ConstructionMethod`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_SpaceArea_GFA.AGF_Name`: AGF_Name_HouseholdShelter on S/N 224; AGF_Name on S/N 651. Default set to `AGF_Name`; the other rows name their list as an override. Decide whether they should really differ.

## Values not in the Space Values list

- S/N 204 (Green Verge) accepts "Groundcover" for `ALS_LandscapeType`, which the Space Values list for ALS_LandscapeType does not contain.
- S/N 219 (Household Shelter) accepts "Setback" for `SpaceName`, which the Space Values list for SpaceName does not contain.
- S/N 761 (Tank (RC Tank)) accepts "portable water tank" for `SpaceName`, which the Space Values list for SpaceName does not contain.

## Labels that look swapped

- S/N 567 is labelled "Egress" but maps `Ingress`, and S/N 568 is labelled "Ingress" but maps `Egress` (Road, IfcCivilElement.*DRIVEWAY). Both properties are still checked; only the labels are crossed.
- S/N 573 is labelled "Egress" but maps `Ingress`, and S/N 574 is labelled "Ingress" but maps `Egress` (Road, IfcCivilElement.*CARRIAGEWAY). Both properties are still checked; only the labels are crossed.

## Duplicate S/N

- S/N 609 is used by 2 rows: "Ambulant Disabled" (SGPset_SanitaryTerminal.AmbulantDisabled), "Barrier Free Accessibility" (SGPset_SanitaryTerminal.BarrierFreeAccessibility).

## Spelling

- Property set spelled `SGPset_CivilElement` and `SGPSet_CivilElement`. Kept `SGPset_CivilElement`; S/N 570, 576 used the other spelling. The checker ignores case, so nothing changes.

## Material set

- `SGPset_Material.Material`: the IFC4 Material Set column is "Name" on 14 of 15 rows and blank on the rest. Set to "Name" for the property.

## Samples that contradict the data type

- `SGPset_SpaceArea_Strata.AST_LegalArea` is Integer but its sample is "101.01, 99.23".
- `SGPset_SpaceArea_Connectivity.ACN_OpenTime` sample "0.99998842592592596" looks like an Excel time value that leaked into the text.
- `SGPset_SpaceArea_Connectivity.ACN_CloseTime` sample "0.99998842592592596" looks like an Excel time value that leaked into the text.

## Value lists

- `AGF_BuildingTypology` lists "Serviced Apartments" 2 times.
