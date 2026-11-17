"""Manual smoke test for the live browser Python geometry API.

Paste this whole file into the WebVSP Python Console, or run it there with
``exec(open(...).read())`` when a local script loader is available. It uses
only the in-memory model; no desktop file paths or browser APIs are required.
"""
import openvsp as vsp


def section(title):
    print("\n== %s ==" % title)


section("reset and create geometry")
vsp.ClearVSPModel()
geom_id = vsp.AddGeom("FUSELAGE")
print("geometry:", geom_id, vsp.GetGeomTypeName(geom_id), vsp.GetGeomName(geom_id))

section("XSec")
surf_ids = vsp.GetXSecSurfIDs(geom_id)
print("surface IDs:", surf_ids)
assert surf_ids, "FUSELAGE should have at least one XSec surface"
surf_id = vsp.GetXSecSurf(geom_id, 0)
print("first surface:", surf_id)

before = vsp.GetNumXSec(surf_id)
print("sections before:", before)
print("section IDs before:", vsp.GetXSecIDs(surf_id))

vsp.InsertXSec(geom_id, 1, vsp.XS_ELLIPSE)
after = vsp.GetNumXSec(surf_id)
inserted_id = vsp.GetXSec(surf_id, 1)
print("sections after ellipse insert:", after)
print("inserted section:", inserted_id)
print("inserted shape:", vsp.GetXSecShape(inserted_id), "(XS_ELLIPSE =", vsp.XS_ELLIPSE, ")")
print("inserted parameter IDs:", vsp.GetXSecParmIDs(inserted_id))

vsp.ChangeXSecShape(surf_id, 1, vsp.XS_CIRCLE)
print("shape after ChangeXSecShape:", vsp.GetXSecShape(vsp.GetXSec(surf_id, 1)))
vsp.ChangeXSecShapeByID(inserted_id, vsp.XS_ELLIPSE)
print("shape after ChangeXSecShapeByID:", vsp.GetXSecShape(inserted_id))

section("SubSurf")
sub_id = vsp.AddSubSurf(geom_id, vsp.SS_RECTANGLE, 0)
print("created sub-surface:", sub_id)
print("sub-surface IDs:", vsp.GetSubSurfIDVec(geom_id))
print("sub-surface count:", vsp.GetNumSubSurf(geom_id))
print("sub-surface by index:", vsp.GetSubSurf(geom_id, 0))
print("sub-surface type:", vsp.GetSubSurfType(sub_id), "(SS_RECTANGLE =", vsp.SS_RECTANGLE, ")")
print("sub-surface name:", vsp.GetSubSurfName(sub_id))
print("sub-surface index:", vsp.GetSubSurfIndex(sub_id))
print("sub-surface parameter IDs:", vsp.GetSubSurfParmIDs(sub_id))

section("Set")
set_names = vsp.GetSetNames()
print("set names:", set_names)
assert set_names, "the model should expose at least one set"
set_index = vsp.GetSetIndex(set_names[0])
print("first set:", set_names[0], "index:", set_index)
print("members before:", vsp.GetGeomSet(set_names[0]))
print("members by index:", vsp.GetGeomSetAtIndex(set_index))

vsp.SetSetFlag(geom_id, set_index, True)
print("geometry set flag:", vsp.GetSetFlag(geom_id, set_index))
print("members after enabling:", vsp.GetGeomSet(set_names[0]))

new_set_name = "ManualGeometryApiSet"
vsp.SetSetName(set_index, new_set_name)
print("renamed set:", vsp.GetSetName(set_index))
print("renamed set index:", vsp.GetSetIndex(new_set_name))
print("renamed set members:", vsp.GetGeomSet(new_set_name))

section("cleanup")
vsp.DeleteSubSurf(geom_id, sub_id)
vsp.CutXSec(geom_id, 1)
print("sub-surfaces remaining:", vsp.GetNumSubSurf(geom_id))
print("sections remaining:", vsp.GetNumXSec(surf_id))
print("manual geometry API smoke test: PASS")
