# Ported from examples/scripts/Wing.vspscript
# Adapted: SetDriverGroup (overloaded) is reported instead of called.
import openvsp as vsp

wid = vsp.AddGeom('WING', '')
for _ in range(3):
    vsp.InsertXSec(wid, 1, vsp.XS_FOUR_SERIES)
vsp.CutXSec(wid, 1)

driver_gap = []
try:
    vsp.SetDriverGroup(wid, 1, vsp.AREA_WSECT_DRIVER, vsp.ROOTC_WSECT_DRIVER, vsp.TIPC_WSECT_DRIVER)
except (AttributeError, TypeError) as exc:
    driver_gap.append(str(exc))

vsp.SetParmVal(wid, 'RotateAirfoilMatchDideralFlag', 'WingGeom', 1.0)
vsp.SetParmVal(wid, 'Root_Chord', 'XSec_1', 7.0)
vsp.SetParmVal(wid, 'Tip_Chord', 'XSec_1', 3.0)
vsp.SetParmVal(wid, 'Area', 'XSec_1', 45.0)
vsp.SetParmVal(wid, 'Sweep', 'XSec_1', 40.0)
vsp.Update()

vsp.SetParmVal(wid, 'Tip_Chord', 'XSec_2', 2.0)
vsp.SetParmVal(wid, 'Sweep', 'XSec_2', 60.0)
vsp.SetParmVal(wid, 'Dihedral', 'XSec_2', 30.0)
vsp.Update()

vsp.SetParmVal(wid, 'Sweep', 'XSec_3', 60.0)
vsp.SetParmVal(wid, 'Dihedral', 'XSec_3', 80.0)
vsp.Update()

vsp.SetParmVal(wid, 'Camber', 'XSecCurve_0', 0.02)
vsp.Update()

manager = vsp.ErrorMgrSingleton.getInstance()
errors = []
while manager.GetNumTotalErrors() > 0:
    errors.append(manager.PopLastError().GetErrorString())
print('driver group gap:', driver_gap)
print('errors:', errors[:3])
