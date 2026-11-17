# Ported from examples/scripts/DumpResults.vspscript
# Adapted: PrintResults() is now provided by the scripting shim layer.
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
    vsp.PrintResults(resid)
    print('')

manager = vsp.ErrorMgrSingleton.getInstance()
while manager.GetNumTotalErrors() > 0:
    print(manager.PopLastError().GetErrorString())
