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
        raise OpenVSPError(str(exc), 'unknown' if operation in ('add_geom', 'set_parm', 'update') else None) from exc
    if not response['ok']:
        error = response['error']
        raise OpenVSPError(error['message'], error.get('outcome'), error.get('actual'), error.get('code'))
    return response['value']


def get_instance(vsp_instance):
    if vsp_instance is not None:
        raise ValueError('Multiple OpenVSP instances are not supported')
    return sys.modules[__name__]


def FindGeom(name, index):
    return _call('find_geom', name=name, index=index)


def AddGeom(type, parent=''):
    return _call('add_geom', type=type, parent=parent)


def GetParmVal(geom_id, name, group):
    return _call('parm_value', geom=geom_id, name=name, group=group)


def SetParmVal(geom_id, name, group, value):
    return _call('set_parm', geom=geom_id, name=name, group=group, value=value)


def Update(update_managers=True):
    return _call('update', update_managers=update_managers)
