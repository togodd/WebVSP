# Ported from examples/scripts/Stack.vspscript
# Adapted: SetDriverGroup is overloaded in the native API and is not bridged;
# the calls are recorded as a known gap instead of aborting the script.
import openvsp as vsp

sid = vsp.AddGeom('STACK', '')
vsp.SetParmVal(sid, 'Tess_W', 'Shape', 29)
vsp.SetParmVal(sid, 'Y_Rel_Rotation', 'XForm', 90)

xsec_surf = vsp.GetXSecSurf(sid, 0)
vsp.ChangeXSecShape(xsec_surf, 1, vsp.XS_GENERAL_FUSE)
vsp.Update()

vsp.SetParmVal(sid, 'Height', 'XSecCurve_1', 2.0)
vsp.SetParmVal(sid, 'Width', 'XSecCurve_1', 5.0)
vsp.SetParmVal(sid, 'MaxWidthLoc', 'XSecCurve_1', 1.0)
vsp.Update()

vsp.CopyXSec(sid, 1)
vsp.PasteXSec(sid, 2)
vsp.PasteXSec(sid, 3)

vsp.SetParmVal(sid, 'XDelta', 'XSec_1', 0.0)
vsp.SetParmVal(sid, 'XDelta', 'XSec_2', 5.0)
vsp.SetParmVal(sid, 'XDelta', 'XSec_3', 5.0)
vsp.SetParmVal(sid, 'XDelta', 'XSec_4', 0.0)
vsp.SetParmVal(sid, 'ZDelta', 'XSec_2', 1.0)
vsp.SetParmVal(sid, 'ZDelta', 'XSec_3', -1.0)
vsp.Update()

driver_gap = []
try:
    vsp.SetDriverGroup(sid, 2, vsp.AREA_XSEC_DRIVER, vsp.HWRATIO_XSEC_DRIVER)
except (AttributeError, TypeError) as exc:
    driver_gap.append(str(exc))

vsp.ChangeXSecShape(xsec_surf, 3, vsp.XS_CIRCLE)
try:
    vsp.SetDriverGroup(sid, 3, vsp.AREA_XSEC_DRIVER)
except (AttributeError, TypeError) as exc:
    driver_gap.append(str(exc))

xsec = vsp.GetXSec(xsec_surf, 2)
vsp.SetXSecContinuity(xsec, 1)
for side in (vsp.XSEC_LEFT_SIDE, vsp.XSEC_RIGHT_SIDE):
    vsp.SetXSecTanAngles(xsec, side, 0.0, 0.0, 0.0, 0.0)
    vsp.SetXSecTanStrengths(xsec, side, 0.5, 0.5, 0.5, 0.5)
vsp.Update()
print('driver group gap:', driver_gap)
