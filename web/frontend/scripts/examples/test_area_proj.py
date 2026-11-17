# Ported from examples/scripts/TestAreaProj.vspscript
# Adapted: closeTo() does not exist (abs comparison); WriteResultsCSVFile() has
# no Python API, so the CSV export step is reported as a gap.
import openvsp as vsp

failure = 0
gaps = []

fid = vsp.AddGeom('POD', '')
vsp.Update()

expected = {
    vsp.X_PROJ: 1.256832229736884132e+00,
    vsp.Y_PROJ: 9.699415664302019735e+00,
    vsp.Z_PROJ: 9.699415664302019735e+00,
}
for direction, want in expected.items():
    vsp.SetAnalysisInputDefaults('Projection')
    vsp.SetIntAnalysisInput('Projection', 'DirectionType', [direction])
    rid = vsp.ExecAnalysis('Projection')
    area = vsp.GetDoubleResults(rid, 'Area', 0)
    print('direction', direction, 'area', area[0], 'expected', want)
    if abs(area[0] - want) > 1e-5:
        failure += 1
    try:
        vsp.WriteResultsCSVFile(rid, 'Proj.csv')
    except (AttributeError, vsp.OpenVSPError) as exc:
        gaps.append('WriteResultsCSVFile: %s' % str(exc)[:60])
    # The projection run leaves a temporary mesh geom behind.
    mesh_ids = vsp.GetStringResults(rid, 'Mesh_GeomID', 0)
    if mesh_ids:
        vsp.DeleteGeomVec(list(mesh_ids))

print('failures:', failure)
print('gaps:', sorted(set(gaps)))
