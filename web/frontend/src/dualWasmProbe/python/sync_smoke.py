import json
import openvsp as vsp
from sync_bridge import request

call = vsp._call
import numpy as np
import six
import utilities
import utilities.transformations as transformations
# The original source is unchanged, but loaded under a separate name because the
# diagnostic openvsp facade is a single module rather than the native package.
vsp.SET_ALL = 0  # native SET_TYPE enum, import-time compatibility shim only
import native_openvsp_utilities as native
get_wing_reference_quantities = native.get_wing_reference_quantities
assert native.vsp_module is vsp and native.RunManager is utilities.RunManager
assert np.__version__ == '2.4.6' and six.__version__ == '1.17.0'
assert (np.arange(3) * 2).tolist() == [0, 2, 4]
assert np.allclose(transformations.TransMatrix().mat, np.eye(4))
assert native.genX3d.__defaults__[1] == native.export_airfoils.__defaults__[0] == 0

wing = call('setup')
parm_ids = vsp.GetGeomParmIDs(wing['id'])
assert parm_ids and len(set(parm_ids)) == len(parm_ids)
parm_id = parm_ids[0]
assert isinstance(vsp.GetParmValByID(parm_id), float)
assert isinstance(vsp.GetIntParmVal(parm_id), int)
assert isinstance(vsp.GetParmName(parm_id), str)
assert isinstance(vsp.GetParmType(parm_id), int)
by_id = get_wing_reference_quantities(wing_id=wing['id'])
by_name = get_wing_reference_quantities(wing_name=wing['name']) if wing['nameUnique'] else None
assert by_name is None or by_name == by_id
assert get_wing_reference_quantities(wing_name='ignored', wing_id=wing['id']) == by_id
for args in ({}, {'wing_name': '__webvsp_sync_probe_missing__'}, {'wing_id': wing['id'], 'vsp_instance': 'other'}):
    try:
        get_wing_reference_quantities(**args)
    except ValueError:
        pass
    else:
        raise AssertionError('Expected ValueError')
try:
    vsp.GetParmVal(wing['id'], 'missing', 'WingGeom')
except RuntimeError:
    pass
else:
    raise AssertionError('Unknown parameter was accepted')

fixture = vsp.ResultsFixtureOpen()
try:
    assert vsp.GetResultsName(fixture) == 'WebVSP_ResultsFixture'
    assert vsp.GetAllDataNames(fixture) == ['Double_Matrix', 'Double_Value', 'Int_Value', 'String_Value', 'Vec3d_Value']
    assert vsp.GetResultsType(fixture, 'Int_Value') == vsp.INT_DATA
    assert vsp.GetResultsType(fixture, 'String_Value') == vsp.STRING_DATA
    assert vsp.GetResultsType(fixture, 'Double_Value') == vsp.DOUBLE_DATA
    assert vsp.GetResultsType(fixture, 'Double_Matrix') == vsp.DOUBLE_MATRIX_DATA
    assert vsp.GetResultsType(fixture, 'Vec3d_Value') == vsp.VEC3D_DATA
    parsed = native.parse_results_object(fixture)
    assert parsed.Int_Value == [42]
    assert parsed.String_Value == ['fixture']
    assert parsed.Double_Value == [3.25]
    assert parsed.Double_Matrix == [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
    assert parsed.Vec3d_Value == [[1.0, 2.0, 3.0]]
finally:
    vsp.ResultsFixtureClose(fixture)

# This is an explicit transfer, NOT a transparent replacement for Python open().
file_reply = call('file_roundtrip', text='python-to-openvsp\n')
assert file_reply == 'openvsp-to-python\n'
try:
    request('timeout_test', '{}')
except Exception as exc:
    assert 'timed out' in str(exc)
else:
    raise AssertionError('Timeout was not reported')
# A new buffer prevents a delayed reply to the previous request contaminating this one.
assert call('ping_slow') == 'ok'
json.dumps({'wingId': wing['id'], 'nameUnique': wing['nameUnique'], 'byId': by_id, 'byName': by_name,
            'fileReply': file_reply, 'repeatedCalls': True, 'timeoutChecked': True,
            'originalModule': native.__name__, 'numpy': np.__version__, 'six': six.__version__,
            'nativeDependencies': True, 'importShim': 'SET_ALL=0'})
