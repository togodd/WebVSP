"""Fixed modeling diagnostic: always adds one root wing to the page model."""
import json
import openvsp as vsp

# Retain native synchronous calling style. Use translation rather than a wing driver:
# wing driver constraints can change requested totals during Update.
wing = vsp.AddGeom('WING')
old = vsp.GetParmVal(wing, 'X_Rel_Location', 'XForm')
requested = old + 2.0
actual = vsp.SetParmVal(wing, 'X_Rel_Location', 'XForm', requested)
assert vsp.Update() is None
readback = vsp.GetParmVal(wing, 'X_Rel_Location', 'XForm')
assert actual == requested == readback

errors = {}
for key, operation in (
    ('invalid_id', lambda: vsp.SetParmVal('__invalid_geom__', 'X_Rel_Location', 'XForm', 1)),
    ('invalid_parameter', lambda: vsp.SetParmVal(wing, 'not_a_parameter', 'XForm', 1)),
    ('outside_limits', lambda: vsp.SetParmVal(wing, 'X_Rel_Location', 'XForm', 1e100)),
    ('unsupported_geom', lambda: vsp.AddGeom('POD')),
    ('unsupported_update', lambda: vsp.Update(False)),
):
    try:
        operation()
    except vsp.OpenVSPError as exc:
        assert exc.outcome == 'not_written', (key, exc.outcome)
        errors[key] = {'message': str(exc), 'outcome': exc.outcome}
    else:
        raise AssertionError(f'{key} did not fail')
assert vsp.GetParmVal(wing, 'X_Rel_Location', 'XForm') == readback
file_reply = vsp._call('file_roundtrip', text='python-to-openvsp\n')
assert file_reply == 'openvsp-to-python\n'
# A timeout on a real in-flight dispatch poisons this session, even if Python catches it.
try:
    vsp._call('timeout_real_test')
except vsp.OpenVSPError as exc:
    assert 'timed out' in str(exc)
else:
    raise AssertionError('Expected timeout')
try:
    vsp.SetParmVal(wing, 'X_Rel_Location', 'XForm', 3)
except vsp.OpenVSPError as exc:
    assert exc.outcome == 'not_written'
else:
    raise AssertionError('Write accepted after timeout')
json.dumps({'wingId': wing, 'oldValue': old, 'requestedValue': requested, 'actualValue': actual,
            'readback': readback, 'errors': errors, 'fileReply': file_reply, 'poisonedSessionChecked': True})
