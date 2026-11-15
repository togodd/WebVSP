import json
import sys
import inspect
import openvsp_wasm as vsp
from webvsp_probe_bridge import request

assert str(inspect.signature(vsp.AddGeom)) == "(type, parent='')"
assert all(inspect.iscoroutinefunction(getattr(vsp, name)) for name in
           ('AddGeom', 'FindGeoms', 'GetGeomName', 'GetGeomTypeName', 'GetGeomParmIDs'))
assert [vsp.PARM_DOUBLE_TYPE, vsp.PARM_INT_TYPE, vsp.PARM_BOOL_TYPE, vsp.PARM_FRACTION_TYPE,
        vsp.PARM_LIMITED_INT_TYPE, vsp.PARM_NOTEQ_TYPE, vsp.PARM_POWER_INT_TYPE] == list(range(7))
before = await vsp.FindGeoms()
wing_id = await vsp.AddGeom(type='WING')
after = await vsp.FindGeoms()
assert wing_id in after and len(after) == len(before) + 1
assert await vsp.GetGeomName(wing_id) == 'WingGeom'
assert await vsp.GetGeomTypeName(wing_id) == 'Wing'

parm_ids = await vsp.GetGeomParmIDs(wing_id)
# Choose the top-level X location: active, finite, and independent of wing drivers.
parameters = [await vsp.GetGeomParm(wing_id, pid) for pid in parm_ids]
matches = [p for p in parameters if p['name'] == 'X_Rel_Location' and p['group'] == 'XForm' and p['container'] == wing_id]
assert len(matches) == 1, 'Expected one top-level XForm/X_Rel_Location parameter'
parm = matches[0]
assert parm['type'] == vsp.PARM_DOUBLE_TYPE
reference_ids = {}
for name in ('TotalArea', 'TotalSpan', 'TotalChord'):
    reference_matches = [p for p in parameters if p['name'] == name and p['group'] == 'WingGeom' and p['container'] == wing_id]
    assert len(reference_matches) == 1
    reference_ids[name] = reference_matches[0]['id']
reference_by_id = await vsp.get_wing_reference_quantities(wing_id=wing_id)
reference_by_name = await vsp.get_wing_reference_quantities(wing_name='WingGeom') if len(before) == 0 else reference_by_id
assert reference_by_id == reference_by_name
assert reference_by_id == tuple(next(p['value'] for p in parameters if p['id'] == reference_ids[name]) for name in ('TotalArea', 'TotalSpan', 'TotalChord'))
try:
    await vsp.get_wing_reference_quantities()
except ValueError:
    pass
else:
    raise AssertionError('Missing wing argument was accepted')
try:
    await vsp.get_wing_reference_quantities(wing_name='__missing_probe_wing__')
except ValueError:
    pass
else:
    raise AssertionError('Unknown wing name was accepted')
old_value = await vsp.GetGeomParmVal(wing_id, parm['id'])
requested = old_value + 2.0
actual = await vsp.SetGeomParmVal(wing_id, parm['id'], requested)
readback = await vsp.GetGeomParmVal(wing_id, parm['id'])
assert actual == requested == readback

try:
    await vsp.SetGeomParmVal(wing_id, parm['id'], parm['upperLimit'] + 1)
except vsp.OpenVSPError as exc:
    assert exc.outcome == 'not_written'
    error = str(exc)
else:
    raise AssertionError('Out-of-range write did not fail')
assert await vsp.GetGeomParmVal(wing_id, parm['id']) == requested

# Verify the transport also rejects unknown operations.
unsupported = json.loads(await request('unsupported', '{}'))
assert not unsupported['ok']
json.dumps({'python': sys.version.split()[0], 'beforeCount': len(before), 'wingId': wing_id,
            'afterCount': len(after), 'parameterCount': len(parm_ids), 'parameterId': parm['id'],
            'parameterName': parm['name'], 'parameterGroup': parm['group'], 'oldValue': old_value,
            'requestedValue': requested, 'actualValue': actual, 'readback': readback,
            'error': error, 'errorOutcome': 'not_written', 'unsupportedError': unsupported['error']['message'],
            'bindingSignature': str(inspect.signature(vsp.AddGeom)), 'parmType': parm['type'],
            'parmDoubleType': vsp.PARM_DOUBLE_TYPE, 'wingReference': reference_by_id,
            'wingReferenceParmIds': reference_ids, 'nameCheckPerformed': len(before) == 0})
