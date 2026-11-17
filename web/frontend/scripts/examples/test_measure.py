# Ported from examples/scripts/TestMeasure.vspscript
# Adapted: closeTo() -> abs comparison; SYM_FLAG::SYM_XZ -> vsp.SYM_XZ.
import openvsp as vsp

failure = 0

gid = vsp.AddGeom('POD', '')
vsp.SetParmVal(gid, 'Y_Rel_Location', 'XForm', 2.0)
vsp.SetParmVal(gid, 'Sym_Planar_Flag', 'Sym', vsp.SYM_XZ)

gid2 = vsp.AddGeom('POD', '')
vsp.SetParmVal(gid2, 'Z_Rel_Location', 'XForm', 4.0)
vsp.Update()

rid = vsp.AddRuler(gid, 1, 0.2, 0.3, gid2, 0, 0.2, 0.3, 'Ruler 1')
vsp.SetParmVal(vsp.FindParm(rid, 'X_Offset', 'Measure'), 6.0)
vsp.SetParmVal(vsp.FindParm(rid, 'Y_Offset', 'Measure'), 7.0)
vsp.SetParmVal(vsp.FindParm(rid, 'Z_Offset', 'Measure'), 8.0)

rid2 = vsp.AddRuler(gid, 0, 0.4, 0.6, gid, 1, 0.8, 0.9, 'Ruler 2')

rulers = vsp.GetAllRulers()
print('Two Rulers:', len(rulers), rulers)
if len(rulers) != 2:
    failure += 1

vsp.DelRuler(rulers[1])
rulers = vsp.GetAllRulers()
print('One Ruler:', len(rulers), rulers)
if len(rulers) != 1:
    failure += 1

distid = vsp.FindParm(rid, 'Distance', 'Measure')
print('Distance before update:', vsp.GetParmVal(distid))
vsp.Update()
d = vsp.GetParmVal(distid)
print('Distance after update:', d)
if abs(d - 4.978881) > 1e-5:
    failure += 1
    print('FAIL ruler distance', d)

pid = vsp.AddProbe(gid, 0, 0.5, 0.8, 'Probe 1')
if not pid:
    failure += 1
    print('FAIL AddProbe returned an empty id')
vsp.SetParmVal(vsp.FindParm(pid, 'Len', 'Measure'), 3.0)
vsp.Update()

manager = vsp.ErrorMgrSingleton.getInstance()
while manager.GetNumTotalErrors() > 0:
    print(manager.PopLastError().GetErrorString())
    failure += 1

print('failures:', failure)
