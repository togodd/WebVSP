# Ported from examples/scripts/SubSurface.vspscript
import openvsp as vsp

print('Begin SubSurface Test')
wid = vsp.AddGeom('WING', '')

ss_line_id = vsp.AddSubSurf(wid, vsp.SS_LINE)
vsp.SetParmVal(wid, 'Const_Line_Value', 'SubSurface_1', 0.4)

parm_id_vec = vsp.GetSubSurfParmIDs(ss_line_id)
print('SS_Line Parms:')
for pid in parm_id_vec:
    print('\tName: %s, Group: %s, ID: %s' % (
        vsp.GetParmName(pid), vsp.GetParmDisplayGroupName(pid), pid))

ss_rec_id = vsp.AddSubSurf(wid, vsp.SS_RECTANGLE)
vsp.SetParmVal(wid, 'Center_W', 'SS_Rectangle_1', 0.0)
vsp.SetParmVal(wid, 'U_Length', 'SS_Rectangle_1', 0.1)
vsp.SetParmVal(wid, 'W_Length', 'SS_Rectangle_1', 0.1)
vsp.Update()

print('Number of SubSurfaces:', vsp.GetNumSubSurf(wid))
id_vec = vsp.GetSubSurfIDVec(wid)
print('SubSurface IDs and Type Indexes ->', [(i, vsp.GetSubSurfType(i)) for i in id_vec])

print('Current Name of SS_Rectangle:', vsp.GetSubSurfName(ss_rec_id))
vsp.SetSubSurfName(ss_rec_id, 'New_SS_Rec_Name')
rec_name = vsp.GetSubSurfName(ss_rec_id)
print('New Name of SS_Rectangle:', rec_name)
print('Index of SS_Rectangle:', vsp.GetSubSurfIndex(ss_rec_id))
print('IDs named %r:' % rec_name, vsp.GetSubSurf(wid, rec_name))

vsp.DeleteSubSurf(ss_line_id)
print('Number of SubSurfaces:', vsp.GetNumSubSurf(wid))

manager = vsp.ErrorMgrSingleton.getInstance()
while manager.GetNumTotalErrors() > 0:
    print(manager.PopLastError().GetErrorString())
print('End SubSurface Test')
