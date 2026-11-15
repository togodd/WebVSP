import json
import sys
import openvsp_wasm as vsp
from webvsp_probe_bridge import request

before = await vsp.FindGeoms()
wing_id = await vsp.AddGeom('WING')
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
            'error': error, 'errorOutcome': 'not_written', 'unsupportedError': unsupported['error']['message']})
