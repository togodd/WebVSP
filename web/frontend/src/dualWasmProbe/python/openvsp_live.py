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
import struct
from collections import namedtuple

from sync_bridge import request


# A parse-scoped cache avoids stale ResultsMgr data across console commands or
# GUI edits. Entries never outlive the synchronous parse that populated them.
_RESULT_PARSE_CACHE = None


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


# ---------------------------------------------------------------- XSec / subsurface

XS_FOUR_SERIES, XS_SIX_SERIES, XS_BICONVEX, XS_WEDGE, XS_ELLIPSE, XS_FILE_AIRFOIL = 0, 1, 2, 3, 4, 6
SS_RECTANGLE, SS_ELLIPSE, SS_CONTROL, SS_LINE, SS_FINITE_LINE = 0, 1, 2, 3, 4


def GetNumXSecSurfs(geom_id):
    return len(_call('live_xsec_surfs', geom_id=geom_id))


def GetXSecSurf(geom_id, index):
    return _call('live_xsec_surfs', geom_id=geom_id)[index]


def GetXSecSurfIDs(geom_id):
    return _call('live_xsec_surfs', geom_id=geom_id)


def GetNumXSec(xsec_surf_id):
    return len(_call('live_xsecs', xsec_surf_id=xsec_surf_id))


def GetXSec(xsec_surf_id, index):
    return _call('live_xsecs', xsec_surf_id=xsec_surf_id)[index]


def GetXSecIDs(xsec_surf_id):
    return _call('live_xsecs', xsec_surf_id=xsec_surf_id)


def GetXSecShape(xsec_id):
    return _call('live_xsec_shape', xsec_id=xsec_id)


def GetXSecParmIDs(xsec_id):
    return _call('live_xsec_parm_ids', xsec_id=xsec_id)


def InsertXSec(geom_id, index, type):
    return _call('live_insert_xsec', geom_id=geom_id, index=index, shape=type)


def CutXSec(geom_id, index):
    return _call('live_delete_xsec', xsec_surf_id=geom_id, index=index)


def DeleteXSec(geom_id, index):
    """Desktop name for removing a section by index on a geom."""
    return CutXSec(geom_id, index)


def ChangeXSecShape(xsec_surf_id, index, type):
    xsec = GetXSec(xsec_surf_id, index)
    return _call('live_change_xsec_shape', xsec_id=xsec, shape=type)


def ChangeXSecShapeByID(xsec_id, type):
    return _call('live_change_xsec_shape', xsec_id=xsec_id, shape=type)


def GetSubSurfIDVec(geom_id):
    return _call('live_sub_surfs', geom_id=geom_id)


def GetNumSubSurf(geom_id):
    return len(GetSubSurfIDVec(geom_id))


def GetSubSurf(geom_id, index):
    return GetSubSurfIDVec(geom_id)[index]


def AddSubSurf(geom_id, type, surfindex=0):
    return _call('live_add_sub_surf', geom_id=geom_id, type=type, surf_index=surfindex)


def DeleteSubSurf(geom_id, sub_id):
    return _call('live_delete_sub_surf', geom_id=geom_id, sub_id=sub_id)


# ---------------------------------------------------------------- sets

def GetNumSets():
    return _call('live_num_sets')


def GetSetName(index):
    return _call('live_set_name', index=index)


def GetSetNames():
    return [GetSetName(i) for i in range(GetNumSets())]


def SetSetName(index, name):
    return _call('live_set_set_name', index=index, name=name)


def GetSetFlag(geom_id, set_index):
    return _call('live_get_set_flag', geom_id=geom_id, set_index=set_index)


def SetSetFlag(geom_id, set_index, flag):
    return _call('live_set_set_flag', geom_id=geom_id, set_index=set_index, flag=bool(flag))


# ---------------------------------------------------------------- parameter info

def GetParmInfo(parm_id):
    return _call('live_parm_info', parm_id=parm_id)


def GetParmInfoByName(geom_id, name, group):
    return _call('live_parm_info', parm_id=_parm_id(geom_id, name, group))


def GetParmValByID(parm_id):
    return _call('live_parm_info', parm_id=parm_id)['value']


def SetParmValByID(parm_id, value):
    return _call('live_parm_set_by_id', parm_id=parm_id, value=float(value))


def _parm_id(geom_id, name, group):
    for pid in GetGeomParmIDs(geom_id):
        info = GetParmInfo(pid)
        if info['name'] == name and info['group'] == group:
            return pid
    raise OpenVSPError('Parameter %s/%s not found on %s' % (group, name, geom_id))


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


def GetResultTree(result_id):
    """Fetch a recursive JSON result tree in one engine request (Phase 3)."""
    return _call('live_result_tree', result_id=result_id)


def _tree_objects(tree):
    return {item['id']: item for item in tree.get('objects', [])}


def parse_results_tree(result_id):
    """Fetch one recursive tree and return both its envelope and ID index."""
    tree = GetResultTree(result_id)
    return tree, _tree_objects(tree)


def _meta(result_id):
    if _RESULT_PARSE_CACHE is None:
        return None
    return _RESULT_PARSE_CACHE.setdefault(result_id, {'names': None, 'name': None, 'types': {}, 'values': {}})


def GetAllDataNames(result_id):
    cached = _meta(result_id)
    if cached is not None and cached['names'] is not None:
        return cached['names']
    value = _call('live_result_names', result_id=result_id)
    if cached is not None:
        cached['names'] = value
    return value


def GetResultsName(result_id):
    cached = _meta(result_id)
    if cached is not None and cached['name'] is not None:
        return cached['name']
    value = _call('live_result_name', result_id=result_id)
    if cached is not None:
        cached['name'] = value
    return value


def GetNumData(result_id, data_name):
    return _call('live_result_num_data', result_id=result_id, name=data_name)


def GetResultsType(result_id, data_name):
    cached = _meta(result_id)
    if cached is not None and data_name in cached['types']:
        return cached['types'][data_name]
    value = _call('live_result_type', result_id=result_id, name=data_name)
    if cached is not None:
        cached['types'][data_name] = value
    return value


def GetResultShape(result_id, data_name, index=0):
    """Diagnostic: rows/cols/total of one result field without transferring it."""
    return _call('live_result_shape', result_id=result_id, name=data_name, index=index)


CHUNK = 100000


def _values(result_id, data_name, index, kind):
    """Reads one field, in chunks when it is large enough to exceed one message."""
    cached = _meta(result_id)
    cache_key = (data_name, int(index), kind)
    if cached is not None and cache_key in cached['values']:
        return cached['values'][cache_key]
    out = []
    offset = 0
    while True:
        response = _call('live_result_values', result_id=result_id,
                         name='%s\x1f%d\x1f%d' % (data_name, offset, CHUNK), index=index)
        if not isinstance(response, dict) or response.get('type') != kind:
            return []
        part = response.get('value') or []
        out.extend(part)
        if len(part) < CHUNK:
            if cached is not None:
                cached['values'][cache_key] = out
            return out
        offset += len(part)


def GetIntResults(result_id, data_name, index=0):
    return _values(result_id, data_name, index, INT_DATA)


def GetBinaryResults(result_id, data_name, index=0):
    """Read a numeric field as a versioned binary record, preserving NaN/Inf."""
    raw = request('live_result_binary_field', json.dumps({'result_id': result_id, 'name': data_name, 'index': index}))
    if isinstance(raw, str):
        response = json.loads(raw)
        raise OpenVSPError((response.get('error') or {}).get('message', 'Binary result failed'))
    data = bytes(raw.to_py() if hasattr(raw, 'to_py') else raw)
    if len(data) < 12 or data[:4] != b'VRB1':
        raise OpenVSPError('Invalid binary result header')
    kind, rows = struct.unpack_from('<II', data, 4)
    pos = 12
    result = []
    if kind not in (INT_DATA, INT_MATRIX_DATA, DOUBLE_DATA, DOUBLE_MATRIX_DATA, VEC3D_DATA):
        raise OpenVSPError('Unsupported binary result type')
    fmt = 'i' if kind in (INT_DATA, INT_MATRIX_DATA) else 'd'
    item_size = 4 if fmt == 'i' else 8
    for _ in range(rows):
        if pos + 4 > len(data):
            raise OpenVSPError('Truncated binary result')
        count = struct.unpack_from('<I', data, pos)[0]
        pos += 4
        if count > (len(data) - pos) // item_size:
            raise OpenVSPError('Truncated binary result values')
        result.append(list(struct.unpack_from('<%d%s' % (count, fmt), data, pos)))
        pos += count * item_size
    if pos != len(data):
        raise OpenVSPError('Unexpected trailing binary result data')
    return result[0] if kind in (INT_DATA, DOUBLE_DATA) and result else result


def GetDoubleResults(result_id, data_name, index=0):
    # Keep the existing chunked path until binary reads have bounded chunking
    # and match the native getter's wrong-type and missing-field semantics.
    return _values(result_id, data_name, index, DOUBLE_DATA)


def GetStringResults(result_id, data_name, index=0):
    return _values(result_id, data_name, index, STRING_DATA)


def GetDoubleMatResults(result_id, data_name, index=0):
    return _values(result_id, data_name, index, DOUBLE_MATRIX_DATA)


def parse_results_object(res_id, vsp_instance=None):
    """Desktop parser, with an operation-scoped cache that cannot go stale later."""
    import openvsp_utilities
    global _RESULT_PARSE_CACHE
    previous = _RESULT_PARSE_CACHE
    if previous is None:
        _RESULT_PARSE_CACHE = {}
    try:
        return openvsp_utilities.parse_results_object(res_id, sys.modules[__name__])
    finally:
        if previous is None:
            _RESULT_PARSE_CACHE = None


def _tree_result(result_id, parsed):
    item = parsed.get(result_id)
    if item is None:
        raise OpenVSPError('Result tree object missing: %s' % result_id)
    names = []
    fields = {}
    for field in item.get('fields', []):
        if field['name'] not in names:
            names.append(field['name'])
        fields[field['name']] = field.get('value')
    return namedtuple(item.get('name') or 'Results', names)(**fields)


def parse_results_object_fast(res_id, vsp_instance=None):
    """Fast live parser: fetch the recursive ResultsMgr graph once."""
    tree, parsed = parse_results_tree(res_id)
    return _tree_result(res_id, parsed), tree, parsed


def parse_surface_patches_fast(export_set, remove_degenerate=True, vsp_instance=None):
    """SurfacePatches helper using one recursive result-tree request."""
    import numpy as np
    from surface_patches import SurfaceComponent, Surface, SurfacePatch
    SetIntAnalysisInput('SurfacePatches', 'Set', [export_set])
    root = ExecAnalysis('SurfacePatches')
    tree, objects = parse_results_tree(root)

    def value(result_id, name):
        item = objects.get(result_id)
        if item is None:
            raise OpenVSPError('Result tree object missing: %s' % result_id)
        for field in item.get('fields', []):
            if field['name'] == name:
                return field.get('value')
        return []

    components = []
    for comp_id in value(root, 'components'):
        surfaces = []
        for surf_id in value(comp_id, 'surfaces'):
            patches = []
            for patch_id in value(surf_id, 'patches'):
                x = value(patch_id, 'x')
                if remove_degenerate and (len(x) <= 1 or len(x[0]) <= 1):
                    continue
                patches.append(SurfacePatch(value(patch_id, 'comp_id')[0], value(patch_id, 'surf_index')[0],
                                            value(patch_id, 'patch_index')[0], np.array(x),
                                            np.array(value(patch_id, 'y')), np.array(value(patch_id, 'z')),
                                            np.array(value(patch_id, 'nx')), np.array(value(patch_id, 'ny')),
                                            np.array(value(patch_id, 'nz'))))
            surfaces.append(Surface(value(surf_id, 'comp_id')[0], value(surf_id, 'surf_index')[0], patches))
        if surfaces:
            components.append(SurfaceComponent(value(comp_id, 'name')[0], value(comp_id, 'id')[0], surfaces))
    return components


class _Vec3d:
    def __init__(self, xyz):
        self._xyz = xyz

    def x(self): return self._xyz[0]
    def y(self): return self._xyz[1]
    def z(self): return self._xyz[2]


def GetVec3dResults(result_id, data_name, index=0):
    return [_Vec3d(p) for p in _values(result_id, data_name, index, VEC3D_DATA)]
