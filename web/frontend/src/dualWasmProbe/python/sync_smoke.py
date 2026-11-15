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
