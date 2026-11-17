# Ported from examples/scripts/DumpResults.vspscript
# Adapted: PrintResults() does not exist in the Python API; the script lists the
# data names instead, which is what the printout was for.
import openvsp as vsp

vsp.ClearVSPModel()
vsp.AddGeom('POD')
vsp.Update()
vsp.SetAnalysisInputDefaults('MassProp')
vsp.ExecAnalysis('MassProp')

for name in vsp.GetAllResultsNames():
    print(name)
    resid = vsp.FindLatestResultsID(name)
    if not resid:
        continue
    for field in vsp.GetAllDataNames(resid):
        print('   ', field, vsp.GetResultsType(resid, field))
    print('')

manager = vsp.ErrorMgrSingleton.getInstance()
while manager.GetNumTotalErrors() > 0:
    print(manager.PopLastError().GetErrorString())
