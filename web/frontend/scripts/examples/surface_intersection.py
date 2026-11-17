# Ported from examples/scripts/SurfaceIntersection.vspscript (analysis part)
import openvsp as vsp

vsp.ClearVSPModel()
fuse = vsp.AddGeom('FUSELAGE')
wing = vsp.AddGeom('WING')
vsp.SetParmVal(wing, 'X_Rel_Location', 'XForm', 3.0)
vsp.Update()

outcome = {}
try:
    vsp.SetAnalysisInputDefaults('SurfaceIntersection')
    root = vsp.ExecAnalysis('SurfaceIntersection')
    outcome['SurfaceIntersection'] = 'ran: ' + str(root)
except vsp.OpenVSPError as exc:
    outcome['SurfaceIntersection'] = 'refused: ' + str(exc)[:70]

for name in ('IntersectGeoms', 'GetSurfaceIntersectResult', 'ComputeSurfaceIntersection'):
    outcome[name] = 'present' if hasattr(vsp, name) else 'missing'

print(outcome)
