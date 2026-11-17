# Ported from examples/scripts/StructuresParmContainerTest.vspscript
# The FeaStructure API is expected to be missing here; the script reports which
# calls the bridge does not provide instead of aborting.
import openvsp as vsp

gaps = []
pod_id = vsp.AddGeom('POD')
vsp.SetParmValUpdate(pod_id, 'X_Rel_Location', 'XForm', 5.0)
vsp.SetParmValUpdate(pod_id, 'X_Rel_Rotation', 'XForm', 90)
vsp.SetParmValUpdate(pod_id, 'Length', 'Design', 15.0)
vsp.Update()

try:
    struct_ind = vsp.AddFeaStruct(pod_id)
    floor_id = vsp.AddFeaPart(pod_id, struct_ind, vsp.FEA_SLICE)
    vsp.SetParmVal(vsp.FindParm(floor_id, 'IncludedElements', 'FeaPart'), vsp.FEA_SHELL_AND_BEAM)
    vsp.SetParmVal(vsp.FindParm(floor_id, 'RelCenterLocation', 'FeaPart'), 0.34)
    vsp.SetParmVal(vsp.FindParm(floor_id, 'OrientationPlane', 'FeaSlice'), vsp.XZ_BODY)
    vsp.SetParmVal(vsp.FindParm(floor_id, 'FeaPropertyIndex', 'FeaPart'), 2)

    line_array_id = vsp.AddFeaSubSurf(pod_id, struct_ind, vsp.SS_LINE_ARRAY)
    vsp.SetParmVal(vsp.FindParm(line_array_id, 'ConstLineType', 'SS_LineArray'), 1)
    vsp.SetParmVal(vsp.FindParm(line_array_id, 'Spacing', 'SS_LineArray'), 0.25)
    vsp.SetParmVal(vsp.FindParm(line_array_id, 'StartLocation', 'SS_LineArray'), 0.125)
    vsp.Update()

    name = vsp.GetFeaStructName(pod_id, struct_ind)
    container = vsp.FindContainer(name, struct_ind)
    print('structure:', name, container)
    for pid in vsp.FindContainerParmIDs(container):
        print('  ', vsp.GetParmName(pid), pid)

    vsp.SetFeaStructName(pod_id, struct_ind, 'Example_Struct')
    print('renamed:', vsp.FindContainer('Example_Struct', struct_ind))
except (AttributeError, TypeError) as exc:
    gaps.append('%s: %s' % (type(exc).__name__, exc))

print('gaps:', gaps)
