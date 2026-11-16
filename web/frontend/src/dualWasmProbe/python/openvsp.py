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
    write = operation in _WRITE_OPERATIONS
    try:
        response = json.loads(request(operation, payload))
    except Exception as exc:
        raise OpenVSPError(str(exc), 'unknown' if write else None, code='TRANSPORT') from exc
    if not isinstance(response, dict) or not isinstance(response.get('ok'), bool):
        raise OpenVSPError('Invalid synchronous response envelope', 'unknown' if write else None, code='INVALID_RESPONSE')
    if not response['ok']:
        error = response.get('error')
        if not isinstance(error, dict) or not isinstance(error.get('message'), str):
            raise OpenVSPError('Invalid synchronous error envelope', 'unknown' if write else None, code='INVALID_RESPONSE')
        outcome = error.get('outcome') if error.get('outcome') in ('not_written', 'different', 'unknown') else ('unknown' if write else None)
        return_actual = error.get('actual') if isinstance(error.get('actual'), (int, float)) or error.get('actual') is None else None
        raise OpenVSPError(error['message'], outcome, return_actual, error.get('code'))
    if 'value' not in response:
        raise OpenVSPError('Successful synchronous response has no value', 'unknown' if write else None, code='INVALID_RESPONSE')
    return response['value']


def get_instance(vsp_instance):
    if vsp_instance is not None:
        raise ValueError('Multiple OpenVSP instances are not supported')
    return sys.modules[__name__]


from _sync_generated import (AddGeom, FindGeom, FindGeoms, GetGeomName, GetGeomTypeName, GetGeomParmIDs,
                             SetGeomName, DeleteGeom, GetParmVal, SetParmVal, Update,
                             GetParmValByID, GetIntParmVal, GetParmName, GetParmType,
                             ResultsFixtureOpen, ResultsFixtureGetAllDataNames as _ResultsFixtureGetAllDataNames,
                             ResultsFixtureGetResultsName as _ResultsFixtureGetResultsName,
                             ResultsFixtureGetType as _ResultsFixtureGetType,
                             ResultsFixtureGetInt as _ResultsFixtureGetInt,
                             ResultsFixtureGetDouble as _ResultsFixtureGetDouble,
                             ResultsFixtureGetString as _ResultsFixtureGetString,
                             ResultsFixtureGetMatrix as _ResultsFixtureGetMatrix,
                             ResultsFixtureGetVec3d as _ResultsFixtureGetVec3d,
                             ResultsFixtureClose, _WRITE_OPERATIONS)

# Native RES_DATA_TYPE values exposed by the real SWIG module. These constants are
# intentionally limited to the result parser's reviewed subset.
INT_DATA = 1
DOUBLE_DATA = 2
STRING_DATA = 3
VEC3D_DATA = 4
DOUBLE_MATRIX_DATA = 6

class _Vec3d:
    def __init__(self, x, y, z): self._v = (x, y, z)
    def x(self): return self._v[0]
    def y(self): return self._v[1]
    def z(self): return self._v[2]

def ResultsFixtureGetAllDataNames(fixture_token): return _ResultsFixtureGetAllDataNames(fixture_token)
def ResultsFixtureGetResultsName(fixture_token): return _ResultsFixtureGetResultsName(fixture_token)
def ResultsFixtureGetType(fixture_token, data_name): return _ResultsFixtureGetType(fixture_token, data_name)
def ResultsFixtureGetInt(fixture_token, data_name, index=0): return _ResultsFixtureGetInt(fixture_token, data_name, index)
def ResultsFixtureGetDouble(fixture_token, data_name, index=0): return _ResultsFixtureGetDouble(fixture_token, data_name, index)
def ResultsFixtureGetString(fixture_token, data_name, index=0): return _ResultsFixtureGetString(fixture_token, data_name, index)
def ResultsFixtureGetMatrix(fixture_token, data_name, index=0): return _ResultsFixtureGetMatrix(fixture_token, data_name, index)
def ResultsFixtureGetVec3d(fixture_token, data_name, index=0): return [_Vec3d(*value) for value in _ResultsFixtureGetVec3d(fixture_token, data_name, index)]

# The fixed parser-facing names use the same signatures as the native Results API,
# while accepting only the opaque fixture token returned by ResultsFixtureOpen.
def GetAllDataNames(res_id): return ResultsFixtureGetAllDataNames(res_id)
def GetResultsName(res_id): return ResultsFixtureGetResultsName(res_id)
def GetResultsType(res_id, data_name): return ResultsFixtureGetType(res_id, data_name)
def GetIntResults(res_id, data_name, index=0): return ResultsFixtureGetInt(res_id, data_name, index)
def GetDoubleResults(res_id, data_name, index=0): return ResultsFixtureGetDouble(res_id, data_name, index)
def GetStringResults(res_id, data_name, index=0): return ResultsFixtureGetString(res_id, data_name, index)
def GetDoubleMatResults(res_id, data_name, index=0): return ResultsFixtureGetMatrix(res_id, data_name, index)
def GetVec3dResults(res_id, data_name, index=0): return ResultsFixtureGetVec3d(res_id, data_name, index)
