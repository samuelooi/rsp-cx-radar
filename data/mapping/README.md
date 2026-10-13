# IFC-SG mapping tables

The CORENET X mapping, split into four tables so that each fact is written once.
Open any of them in Excel.

| File | One row is | Example |
|---|---|---|
| `element-types.csv` | an IFC entity with one subtype | `IfcDoor.*BLASTDOOR` |
| `properties.csv` | a property in a property set | `SGPset_DoorDimension.ClearWidth`, Length, mm |
| `value-lists.csv` | one accepted value in a named list | list `FireRating`, value `1.5` |
| `requirements.csv` | an authority asking for a property on some element types | SCDF, CG, Door, `SGPset_DoorDimension.ClearWidth` |

The tables point at each other by name. A requirement names its element types
and its property, and a property names its value list. Change a unit or an
accepted value once, and every requirement that uses it follows.

## Element types

`type_id` is the entity, a dot, then the subtype, written the way the workbook
writes it:

- `IfcDoor.DOOR`: the subtype is the IFC **PredefinedType**.
- `IfcDoor.*BLASTDOOR`: the `*` means a user-defined subtype. The model carries
  it in **ObjectType**, with PredefinedType set to USERDEFINED.
- `IfcWall`: no subtype, so any IfcWall.

`name_in_ifc` spells this out for each row.

## Properties

`prop_id` is the property set, a dot, then the property name. `data_type` and
`unit` are what the property must hold.

`value_list` names the list of accepted values in `value-lists.csv`. Leave it
blank when any value is accepted. Two cases need no list:

- **Boolean** properties accept TRUE or FALSE.
- `POSITIVE_NUMBER` means any number above zero.

`material_set` and `sample` are copied from the workbook for reference.

## Value lists

One row per value. All rows with the same `list` name form one list.
`scope` is used only by the Space Values lists. For example, `AGF_Name` values
are scoped by development use, so "Bedroom" is listed under Residential.
`source` says where the list came from in the workbook.

## Requirements

One row per workbook row, keeping its `sn` (the workbook S/N) so you can find
it in the authority's sheet.

- `gateway` is `DG` (Design Gateway, also checked at Construction) or `CG`
  (Construction Gateway only).
- `rsp_priority`, `rsp_category`, `rsp_typology` are RSP's own triage.
- `element_types` lists one or more `type_id`s, separated by `; `.
- `property` is a `prop_id`. A row with no property only says these
  element types must be identified in the model.
- `value_list_override` is for the rare row that accepts a different list from
  the property's usual one, for example Household Shelter's `SpaceName`.
  `NONE` means this row accepts any value.
- `sample` is filled only where this row's sample differs from the property's.

## Things to resolve

`REVIEW.md` lists what didn't line up in the workbook: lists that disagree,
crossed labels, a repeated S/N and similar. Each item is a decision for you.

## Where these came from

`tools/split-mapping.mjs` made these tables from `data/ifcsg-rules.json` and
checked that every rule rebuilds from them exactly. For now the checker still
reads `data/ifcsg-rules.json`. The next step switches the build to read these
tables instead, with a check that every name a row points at exists.
