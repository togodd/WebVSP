"""Small asynchronous OpenVSP-inspired interface for the current WebVSP model.

This is not the native openvsp module. See the compatibility notes in the probe README.
"""
import json
from webvsp_probe_bridge import request


class OpenVSPError(Exception):
    """An engine or transport failure, with a write outcome when available."""

    def __init__(self, message, outcome=None, actual=None, code=None):
        super().__init__(message)
        self.outcome = outcome
        self.actual = actual
        self.code = code


async def _call(operation, **arguments):
    response = json.loads(await request(operation, json.dumps(arguments, allow_nan=False)))
    if not response['ok']:
        error = response['error']
        raise OpenVSPError(error['message'], error.get('outcome'), error.get('actual'), error.get('code'))
    return response['value']


from ._generated import *  # noqa: F403 — reviewed generated public API


async def FindGeom(name, index):
    """Find a geometry by name in model order, or return an empty ID."""
    return await _call('find_geom', name=name, index=index)


async def GetGeomNamedParmValues(geom_id, names, group):
    """Read unique top-level WingGeom reference values (WebVSP extension)."""
    return await _call('wing_reference_parms', geom_id=geom_id, names=names, group=group)


async def GetGeomParm(geom_id, parm_id):
    """Return scoped parameter metadata as a dictionary (WebVSP extension)."""
    return await _call('parm', geom_id=geom_id, parm_id=parm_id)


async def GetGeomParmVal(geom_id, parm_id):
    """Read a parameter value using an explicit owner (WebVSP extension)."""
    return (await GetGeomParm(geom_id, parm_id))['value']


async def SetGeomParmVal(geom_id, parm_id, value):
    """Validate, set, update and read back a scoped parameter (WebVSP extension)."""
    return await _call('set_parm', geom_id=geom_id, parm_id=parm_id, value=value)


from .utilities import get_wing_reference_quantities
