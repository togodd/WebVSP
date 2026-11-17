# Ported from examples/scripts/CreateEditGeom.vspscript
# AngelScript->Python: type declarations dropped, Print() -> print, error loop
# uses ErrorMgrSingleton (the free functions no longer exist).
import openvsp as vsp

# TransportFuse is a custom component (.vsppart); the browser engine has not
# loaded it, so the faithful port fails here. See REPORT.md, cause A.
fid = vsp.AddGeom('TransportFuse', '')
len_id = vsp.GetParm(fid, 'Length', 'Design')
vsp.SetParmVal(len_id, 30.0)
vsp.SetParmVal(fid, 'Diameter', 'Design', 4.0)

wid = vsp.AddGeom('WING', '')
vsp.SetParmVal(wid, 'Span', 'XSec_1', 15.0)
vsp.SetParmVal(wid, 'Root_Chord', 'XSec_1', 10.0)
vsp.SetParmVal(wid, 'Tip_Chord', 'XSec_1', 3.0)
vsp.SetParmVal(wid, 'Sweep', 'XSec_1', 45.0)
vsp.SetParmVal(wid, 'X_Rel_Location', 'XForm', 8.0)

vsp.Update()

manager = vsp.ErrorMgrSingleton.getInstance()
while manager.GetNumTotalErrors() > 0:
    print(manager.PopLastError().GetErrorString())
print('geoms:', vsp.FindGeoms())
