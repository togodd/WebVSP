# Ported from examples/scripts/CpSlicer.vspscript (setup only)
# CpSlicer needs a VSPAERO solution (*.adb) plus the vsploads program, so it is
# expected to be refused until that chain is bridged.
import openvsp as vsp

vsp.ClearVSPModel()
wing = vsp.AddGeom('WING')
vsp.Update()
vsp.SetVSP3FileName('/work/cpslice.vsp3')

outcome = {}
try:
    vsp.SetAnalysisInputDefaults('VSPAEROComputeGeometry')
    vsp.ExecAnalysis('VSPAEROComputeGeometry')
    outcome['compute_geometry'] = 'ok'
except vsp.OpenVSPError as exc:
    outcome['compute_geometry'] = 'error: ' + str(exc)[:60]

for name in ('ComputeVSPAEROCpSlices', 'SetVSPAEROCpSliceSetup', 'GetAllCpSlices'):
    outcome[name] = 'present' if hasattr(vsp, name) else 'missing'

try:
    vsp.SetAnalysisInputDefaults('CpSlicer')
    outcome['CpSlicer'] = 'ran: ' + str(vsp.ExecAnalysis('CpSlicer'))
except vsp.OpenVSPError as exc:
    outcome['CpSlicer'] = 'refused: ' + str(exc)[:60]

print(outcome)
