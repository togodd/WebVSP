# Ported from examples/scripts/DegenGeom.vspscript
# Adapted: the legacy SetComputationFileName/ComputeDegenGeom pair was replaced
# by the analysis API (ExecAnalysis('DegenGeom')); file output stays off because
# the browser has no host file system.
import openvsp as vsp

# TransportFuse is a custom component; the engine now writes the bundled
# examples/CustomScripts files into its file system before the first scan.
fid = vsp.AddGeom('TransportFuse', '')
wid = vsp.AddGeom('WING', '')

vsp.SetParmVal(wid, 'X_Rel_Location', 'XForm', 2.5)
vsp.SetParmVal(wid, 'TotalArea', 'WingGeom', 25)
vsp.Update()

vsp.SetAnalysisInputDefaults('DegenGeom')
vsp.SetIntAnalysisInput('DegenGeom', 'WriteCSVFlag', [0])
root = vsp.ExecAnalysis('DegenGeom')
print('degen root:', root)
print('names:', [n for n in vsp.GetAllResultsNames() if 'Degen' in n])
