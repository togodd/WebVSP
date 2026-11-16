"""Native-shaped facade over the live page model.

Scripts import this as ``openvsp`` and call it the way they call the desktop
module: ``ExecAnalysis``, result getters, ``SetParmVal(geom, name, group, value)``.
Everything runs on the page's own OpenVSP model and engine thread.

Differences from the desktop module are deliberate and documented: file output
from analyses is disabled, the analysis always covers the whole model, and a
crash or out-of-memory in the analysis takes the page session with it.
"""
import json
import sys

from sync_bridge import request

SET_ALL = 0
INT_DATA, DOUBLE_DATA, STRING_DATA, VEC3D_DATA, INT_MATRIX_DATA, DOUBLE_MATRIX_DATA = 1, 2, 3, 4, 5, 6


class OpenVSPError(RuntimeError):
    pass


def _call(operation, **arguments):
    response = json.loads(request(operation, json.dumps(arguments, allow_nan=False)))
    if not isinstance(response, dict) or not isinstance(response.get('ok'), bool):
        raise OpenVSPError('Invalid synchronous response envelope')
    if not response['ok']:
        error = response.get('error') or {}
        raise OpenVSPError(error.get('message') or 'OpenVSP call failed')
    return response.get('value')


def get_instance(instance=None):
    if instance is not None and instance is not sys.modules[__name__]:
        raise ValueError('Multiple OpenVSP instances are not supported')
    return sys.modules[__name__]


# ---------------------------------------------------------------- geometry

def AddGeom(type, parent=''):
    return _call('live_add_geom', type=type, parent=parent)


def DeleteGeom(geom_id, clone_delete=1):
    return _call('live_delete_geom', geom_id=geom_id)


def Update(update_managers=True):
    return _call('live_update', update_managers=bool(update_managers))


def FindGeoms():
    return _call('find_geoms')


def FindGeom(name, index=0):
    return _call('find_geom', name=name, index=index)


def GetGeomName(geom_id):
    return _call('geom_name', geom_id=geom_id)


def GetGeomTypeName(geom_id):
    return _call('geom_type', geom_id=geom_id)


def GetGeomParmIDs(geom_id):
    return _call('geom_parm_ids', geom_id=geom_id)


def GetParmVal(geom_id, name, group):
    return _call('live_parm_get', geom_id=geom_id, key=group + '\x1f' + name)


def SetParmVal(geom_id, name, group, value):
    return _call('live_parm_set', geom_id=geom_id, key=group + '\x1f' + name, value=float(value))


# ---------------------------------------------------------------- analyses

def SetAnalysisInputDefaults(analysis):
    return _call('live_analysis_defaults', analysis=analysis)


def SetIntAnalysisInput(analysis, name, values, index=0):
    if index != 0 or not isinstance(values, (list, tuple)) or len(values) != 1 or type(values[0]) is not int:
        raise ValueError('Only one integer value per analysis input is supported')
    return _call('live_analysis_set_int', analysis=analysis, name=name, value=values[0])


def ExecAnalysis(analysis):
    return _call('live_analysis_run', analysis=analysis)


# ---------------------------------------------------------------- results

def GetAllResultsIDs():
    return _call('live_results_ids')


def GetAllDataNames(result_id):
    return _call('live_result_names', result_id=result_id)


def GetResultsName(result_id):
    return _call('live_result_name', result_id=result_id)


def GetNumData(result_id, data_name):
    return _call('live_result_num_data', result_id=result_id, name=data_name)


def GetResultsType(result_id, data_name):
    return _call('live_result_type', result_id=result_id, name=data_name)


def GetResultShape(result_id, data_name, index=0):
    """Diagnostic: rows/cols/total of one result field without transferring it."""
    return _call('live_result_shape', result_id=result_id, name=data_name, index=index)


def _values(result_id, data_name, index, kind):
    response = _call('live_result_values', result_id=result_id, name=data_name, index=index)
    if not isinstance(response, dict) or response.get('type') != kind:
        return []
    return response.get('value') or []


def GetIntResults(result_id, data_name, index=0):
    return _values(result_id, data_name, index, INT_DATA)


def GetDoubleResults(result_id, data_name, index=0):
    return _values(result_id, data_name, index, DOUBLE_DATA)


def GetStringResults(result_id, data_name, index=0):
    return _values(result_id, data_name, index, STRING_DATA)


def GetDoubleMatResults(result_id, data_name, index=0):
    return _values(result_id, data_name, index, DOUBLE_MATRIX_DATA)


def parse_results_object(res_id, vsp_instance=None):
    """Desktop openvsp.utilities.parse_results_object, bound to this live module."""
    import openvsp_utilities
    return openvsp_utilities.parse_results_object(res_id, sys.modules[__name__])


class _Vec3d:
    def __init__(self, xyz):
        self._xyz = xyz

    def x(self): return self._xyz[0]
    def y(self): return self._xyz[1]
    def z(self): return self._xyz[2]


def GetVec3dResults(result_id, data_name, index=0):
    return [_Vec3d(p) for p in _values(result_id, data_name, index, VEC3D_DATA)]
