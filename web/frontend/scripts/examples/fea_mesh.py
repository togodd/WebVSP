# Ported from examples/scripts/FEAMesh.vspscript (structure setup only)
# The FEAMesh analysis is refused by the bridge, so this port documents that
# rather than reproducing the whole 246-line script.
import openvsp as vsp

vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()

outcome = {}
try:
    vsp.SetAnalysisInputDefaults('FeaMeshAnalysis')
    outcome['FeaMeshAnalysis'] = 'ran: ' + str(vsp.ExecAnalysis('FeaMeshAnalysis'))
except vsp.OpenVSPError as exc:
    outcome['FeaMeshAnalysis'] = 'refused: ' + str(exc)[:60]

try:
    vsp.SetAnalysisInputDefaults('FeaMeshExport')
    outcome['FeaMeshExport'] = 'ran: ' + str(vsp.ExecAnalysis('FeaMeshExport'))
except vsp.OpenVSPError as exc:
    outcome['FeaMeshExport'] = 'refused: ' + str(exc)[:60]

# The geometry-side FEA API the script needs.
for name in ('AddFeaStruct', 'AddFeaPart', 'AddFeaMaterial', 'SetFeaMeshVal'):
    outcome[name] = 'present' if hasattr(vsp, name) else 'missing'

print(outcome)
