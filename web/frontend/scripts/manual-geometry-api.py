"""Manual smoke test for the live browser Python geometry API.

WARNING: This script clears and replaces the current model. Save your model
first, then paste the whole file into the WebVSP Python Console. It uses only
the in-memory model; no desktop file paths or browser APIs are required.
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
inserted_id = vsp.GetXSec(surf_id, 2)
print("sections after ellipse insert:", after)
print("inserted section:", inserted_id)
print("inserted shape:", vsp.GetXSecShape(inserted_id), "(XS_ELLIPSE =", vsp.XS_ELLIPSE, ")")
print("inserted parameter IDs:", vsp.GetXSecParmIDs(inserted_id))

vsp.ChangeXSecShape(surf_id, 2, vsp.XS_CIRCLE)
inserted_id = vsp.GetXSec(surf_id, 2)
print("shape after ChangeXSecShape:", vsp.GetXSecShape(inserted_id))
vsp.ChangeXSecShapeByID(inserted_id, vsp.XS_ELLIPSE)
print("shape after ChangeXSecShapeByID:", vsp.GetXSecShape(inserted_id))

section("SubSurf")
sub_id = vsp.AddSubSurf(geom_id, vsp.SS_RECTANGLE, 0)
print("created sub-surface:", sub_id)
print("sub-surface IDs:", vsp.GetSubSurfIDVec(geom_id))
print("sub-surface count:", vsp.GetNumSubSurf(geom_id))
print("sub-surface by index:", vsp.GetSubSurf(geom_id, 0))
print("sub-surface type:", vsp.GetSubSurfType(sub_id), "(SS_RECTANGLE =", vsp.SS_RECTANGLE, ")")
vsp.SetSubSurfName(sub_id, "ManualRectangle")
print("sub-surface name:", vsp.GetSubSurfName(sub_id))
assert vsp.GetSubSurf(geom_id, "ManualRectangle") == [sub_id]
print("sub-surface index:", vsp.GetSubSurfIndex(sub_id))
print("sub-surface parameter IDs:", vsp.GetSubSurfParmIDs(sub_id))

section("geometry display and batch edits")
print("draw type:", vsp.GetGeomDrawType(geom_id))
vsp.SetGeomDrawType(geom_id, 1)
print("draw type after change:", vsp.GetGeomDrawType(geom_id))
print("wire colour:", vsp.GetGeomWireColor(geom_id))
vsp.SetGeomWireColor(geom_id, (12, 34, 56))
print("wire colour after change:", vsp.GetGeomWireColor(geom_id))

bbox_min = vsp.GetGeomBBoxMin(geom_id)
bbox_max = vsp.GetGeomBBoxMax(geom_id)
print("bounding box:", bbox_min, bbox_max)
assert all(bbox_min.x() <= bbox_max.x() + 1e-9 for _ in (0,)), "bounding box is inverted"

point = vsp.CompPnt01(geom_id, 0, 0.5, 0.5)
normal = vsp.CompNorm01(geom_id, 0, 0.5, 0.5)
print("surface point and normal:", point, normal)
d, u, w = vsp.ProjPnt01(geom_id, 0, (point.x() + normal.x(), point.y() + normal.y(), point.z() + normal.z()))
print("projection distance, u, w:", d, u, w)
k1, k2, ka, kg = vsp.CompCurvature01(geom_id, 0, 0.25, 0.75)
print("curvature k1/k2/mean/gaussian:", k1, k2, ka, kg)

clone = vsp.CloneGeomVec([geom_id], "_ManualCopy")
print("cloned geometries:", clone)
vsp.DeleteGeomVec(clone)
print("geometries after batch delete:", vsp.FindGeoms())

section("parameter metadata")
parm = vsp.GetParm(geom_id, "Length", "Design")
print("parameter:", parm, vsp.GetParmDescript(parm), "container:", vsp.GetParmContainer(parm))
value_before = vsp.GetParmVal(parm)
print("value with limits:", vsp.SetParmValLimits(parm, value_before, 0.1, 100.0))

section("Set")
set_names = vsp.GetSetNames()
print("set names:", set_names)
assert set_names, "the model should expose at least one set"
set_index = 3  # First user set; 0–2 are built-in sets.
assert len(set_names) > set_index, "the model should expose a user set"
print("user set:", set_names[set_index], "index:", set_index)
print("members before:", vsp.GetGeomSet(set_names[set_index]))
print("members by index:", vsp.GetGeomSetAtIndex(set_index))

vsp.SetSetFlag(geom_id, set_index, True)
print("geometry set flag:", vsp.GetSetFlag(geom_id, set_index))
print("members after enabling:", vsp.GetGeomSet(set_names[set_index]))

new_set_name = "ManualGeometryApiSet"
vsp.SetSetName(set_index, new_set_name)
print("renamed set:", vsp.GetSetName(set_index))
print("renamed set index:", vsp.GetSetIndex(new_set_name))
print("renamed set members:", vsp.GetGeomSet(new_set_name))

section("cleanup")
vsp.DeleteSubSurf(geom_id, sub_id)
vsp.CutXSec(geom_id, 2)
print("sub-surfaces remaining:", vsp.GetNumSubSurf(geom_id))
print("sections remaining:", vsp.GetNumXSec(surf_id))
print("manual geometry API smoke test: PASS")
