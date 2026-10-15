# Mapping review

Things found while splitting the workbook `industry-mapping-4-dec-2025_gateway mapping.xlsx` into the four tables: 235 element types, 530 properties, 51 value lists, 832 requirements.

Every discipline is included.

Nothing below changes what the checker does today. Each item is a decision for you: fix the table, or leave it and delete the item.

## Read this first

- 8 rows (S/N 830, 831, 833, 834, 837, 832, 836, 835) say "all subtypes in COP". The checker has always treated that the same as no subtype, so they point at the bare entity (e.g. IfcWindow).
- 402 rows have no RSP_Gateway (STR 183, MEP 219). The checker treats a blank gateway as CG, Construction Gateway only. Fill in DG for any that the Design Gateway asks for.

## Accepted values that disagree

- `SGPset_SpaceArea_GFA.AGF_Name`: AGF_Name on S/N 651; AGF_Name_HouseholdShelter on S/N 224. Default set to `AGF_Name`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_SpaceArea_Landscape.ALS_GreeneryFeatures`: ALS_GreeneryFeatures_AreaALS on S/N 203; ALS_GreeneryFeatures on S/N 670. Default set to `ALS_GreeneryFeatures`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_SpaceArea_Landscape.ALS_LandscapeType`: ALS_LandscapeType_AreaALS on S/N 204; ALS_LandscapeType on S/N 669. Default set to `ALS_LandscapeType`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_GeographicElement.Status`: Status on S/N 144; ALS_Status on S/N 202; Status_Planting on S/N 258; Status_PlantingAreas on S/N 389. Default set to `Status`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_Space.SpaceName`: SpaceName_HouseholdShelter on S/N 219; (no list) on S/N 462; SpaceName_Room on S/N 292; SpaceName_RefuseChuteRecyclablesChute on S/N 528; SpaceName on S/N 697; SpaceName_Tank on S/N 761; SpaceName_Staircase on S/N 723. Default set to `SpaceName`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_Space.ConstructionMethod`: ConstructionMethod on S/N 220, 529; ConstructionMethod_PrefabSpace on S/N 465. Default set to `ConstructionMethod`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_PipeSegment.ConstructionMethod`: (no list) on S/N 341; ConstructionMethod_PrefabricatedBuildingSystemsandMEPComponents on S/N 475. Default set to `(no list)`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_DuctFitting.ConstructionMethod`: (no list) on S/N 352; ConstructionMethod_PrefabricatedBuildingSystemsandMEPComponents on S/N 489. Default set to `(no list)`; the other rows name their list as an override. Decide whether they should really differ.
- `SGPset_DuctSegment.ConstructionMethod`: (no list) on S/N 357; ConstructionMethod_PrefabricatedBuildingSystemsandMEPComponents on S/N 481. Default set to `(no list)`; the other rows name their list as an override. Decide whether they should really differ.

## Values not in the Space Values list

- S/N 204 (Green Verge) accepts "Groundcover" for `ALS_LandscapeType`, which the Space Values list for ALS_LandscapeType does not contain.
- S/N 219 (Household Shelter) accepts "Setback" for `SpaceName`, which the Space Values list for SpaceName does not contain.
- S/N 761 (Tank (RC Tank)) accepts "portable water tank" for `SpaceName`, which the Space Values list for SpaceName does not contain.

## Labels that look swapped

- S/N 573 is labelled "Egress" but maps `Ingress`, and S/N 574 is labelled "Ingress" but maps `Egress` (Road, IfcCivilElement.USERDEFINED.CARRIAGEWAY). Both properties are still checked; only the labels are crossed.
- S/N 567 is labelled "Egress" but maps `Ingress`, and S/N 568 is labelled "Ingress" but maps `Egress` (Road, IfcCivilElement.USERDEFINED.DRIVEWAY). Both properties are still checked; only the labels are crossed.

## Duplicate S/N

- S/N 609 is used by 2 rows: "Ambulant Disabled" (SGPset_SanitaryTerminal.AmbulantDisabled), "Barrier Free Accessibility" (SGPset_SanitaryTerminal.BarrierFreeAccessibility).

## Spelling

- Property set spelled `SGPset_CivilElement` and `SGPSet_CivilElement`. Kept `SGPset_CivilElement`; S/N 576, 570 used the other spelling. The checker ignores case, so nothing changes.
- Property set spelled `SGPset_StairFlight` and `SGPset_Stairflight`. Kept `SGPset_StairFlight`; S/N 739 used the other spelling. The checker ignores case, so nothing changes.

## Material set

- `SGPset_Material.Material`: the IFC4 Material Set column is "Name" on 19 of 20 rows and blank on the rest. Set to "Name" for the property.

## Samples that contradict the data type

- `SGPset_SpaceArea_Connectivity.ACN_OpenTime` sample "0.99998842592592596" looks like an Excel time value that leaked into the text.
- `SGPset_SpaceArea_Connectivity.ACN_CloseTime` sample "0.99998842592592596" looks like an Excel time value that leaked into the text.
- `SGPset_SpaceArea_Strata.AST_LegalArea` is Integer but its sample is "101.01, 99.23".

## Data types and units

- `SGPset_FireSuppressionTerminal.Hose_NominalDiameter` is Label on S/N 39 but Length (mm) elsewhere. The property keeps Length (mm), so that row will be checked as Length (mm) once the build reads these tables. Change the property row if that is wrong.

## Value lists

- `AGF_BuildingTypology` lists "Serviced Apartments" 2 times.
