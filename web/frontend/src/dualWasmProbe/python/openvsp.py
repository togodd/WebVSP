"""Restricted synchronous facade for the fixed WebVSP diagnostic; not native openvsp."""
import json
import sys
from sync_bridge import request


class OpenVSPError(RuntimeError):
    def __init__(self, message, outcome=None, actual=None, code=None):
        super().__init__(message)
        self.outcome, self.actual, self.code = outcome, actual, code


def _call(operation, **arguments):
    payload = json.dumps(arguments, allow_nan=False)
    try:
        response = json.loads(request(operation, payload))
    except Exception as exc:
        raise OpenVSPError(str(exc), 'unknown' if operation in _WRITE_OPERATIONS else None) from exc
    if not response['ok']:
        error = response['error']
        raise OpenVSPError(error['message'], error.get('outcome'), error.get('actual'), error.get('code'))
    return response['value']


def get_instance(vsp_instance):
    if vsp_instance is not None:
        raise ValueError('Multiple OpenVSP instances are not supported')
    return sys.modules[__name__]


from _sync_generated import AddGeom, FindGeom, GetParmVal, SetParmVal, Update, _WRITE_OPERATIONS
