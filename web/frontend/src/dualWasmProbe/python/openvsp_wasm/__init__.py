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


async def FindGeoms():
    """Return IDs in the current model, analogous to native FindGeoms()."""
    return await _call('find_geoms')


async def GetGeomName(geom_id):
    """Return a current geometry name."""
    return await _call('geom_name', geom_id=geom_id)


async def GetGeomTypeName(geom_id):
    """Return a current geometry type name."""
    return await _call('geom_type', geom_id=geom_id)


async def AddGeom(geom_type, parent=''):
    """Add a geometry; this subset currently accepts only a root WING."""
    return await _call('add_geom', geom_type=geom_type, parent=parent)


async def GetGeomParmIDs(geom_id):
    """Return the IDs linkable to a geometry, including nested containers."""
    return await _call('parm_ids', geom_id=geom_id)


async def GetGeomParm(geom_id, parm_id):
    """Return scoped parameter metadata as a dictionary (WebVSP extension)."""
    return await _call('parm', geom_id=geom_id, parm_id=parm_id)


async def GetGeomParmVal(geom_id, parm_id):
    """Read a parameter value using an explicit owner (WebVSP extension)."""
    return (await GetGeomParm(geom_id, parm_id))['value']


async def SetGeomParmVal(geom_id, parm_id, value):
    """Validate, set, update and read back a scoped parameter (WebVSP extension)."""
    return await _call('set_parm', geom_id=geom_id, parm_id=parm_id, value=value)
