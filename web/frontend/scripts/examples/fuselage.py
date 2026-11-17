# Ported from examples/scripts/Fuselage.vspscript
# Adapted: ComputeCompGeom() -> ExecAnalysis('CompGeom'); 3-argument
# SetXSecTanAngles/Strengths fan out to both sides because the native signature
# takes (side, top, right, bottom, left).
import openvsp as vsp

fid = vsp.AddGeom('FUSELAGE', '')
vsp.SetParmVal(fid, 'Tess_W', 'Shape', 49)

vsp.InsertXSec(fid, 1, vsp.XS_ROUNDED_RECTANGLE)
vsp.SetParmVal(fid, 'RoundedRect_Width', 'XSecCurve_2', 4.0)
vsp.CopyXSec(fid, 2)
vsp.PasteXSec(fid, 1)
vsp.PasteXSec(fid, 3)
vsp.PasteXSec(fid, 4)
vsp.CutXSec(fid, 2)

xsec_surf = vsp.GetXSecSurf(fid, 0)
num_xsecs = vsp.GetNumXSec(xsec_surf)
for i in range(num_xsecs):
    xsec = vsp.GetXSec(xsec_surf, i)
    vsp.SetXSecContinuity(xsec, 1)
    for side in (vsp.XSEC_LEFT_SIDE, vsp.XSEC_RIGHT_SIDE):
        vsp.SetXSecTanAngles(xsec, side, 0.0, 0.0, 0.0, 0.0)
        vsp.SetXSecTanStrengths(xsec, side, 0.5, 0.5, 0.5, 0.5)

for side in (vsp.XSEC_LEFT_SIDE, vsp.XSEC_RIGHT_SIDE):
    vsp.SetXSecTanAngles(vsp.GetXSec(xsec_surf, 0), side, 90.0, 90.0, 90.0, 90.0)
    vsp.SetXSecTanAngles(vsp.GetXSec(xsec_surf, num_xsecs - 1), side, -90.0, -90.0, -90.0, -90.0)

vsp.Update()

vsp.SetAnalysisInputDefaults('CompGeom')
root = vsp.ExecAnalysis('CompGeom')
comp_res_id = vsp.FindLatestResultsID('Comp_Geom')
wet = vsp.GetDoubleResults(comp_res_id, 'Wet_Area', 0)
print('Wet_Area =', wet[0])
print('root:', root)
