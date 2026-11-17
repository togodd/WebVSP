"""Native-shaped facade over the live page model.

Scripts import this as ``openvsp`` and call it the way they call the desktop
module: ``ExecAnalysis``, result getters, ``SetParmVal(geom, name, group, value)``.
Everything runs on the page's own OpenVSP model and engine thread.

Differences from the desktop module are deliberate: analysis input and output
handling depends on the analysis policy, and a crash or out-of-memory in an
analysis takes the page session with it.
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
# Keep in step with APIDefines.h PARM_TYPE.
PARM_DOUBLE_TYPE, PARM_INT_TYPE, PARM_BOOL_TYPE, PARM_FRACTION_TYPE = 0, 1, 2, 3
PARM_LIMITED_INT_TYPE, PARM_NOTEQ_TYPE, PARM_POWER_INT_TYPE = 4, 5, 6

# Keep in step with APIDefines.h XSEC_CRV_TYPE and SUBSURF_TYPE.
XS_UNDEFINED = -1
(XS_POINT, XS_CIRCLE, XS_ELLIPSE, XS_SUPER_ELLIPSE, XS_ROUNDED_RECTANGLE,
 XS_GENERAL_FUSE, XS_FILE_FUSE, XS_FOUR_SERIES, XS_SIX_SERIES, XS_BICONVEX,
 XS_WEDGE, XS_EDIT_CURVE, XS_FILE_AIRFOIL, XS_CST_AIRFOIL, XS_VKT_AIRFOIL,
 XS_FOUR_DIGIT_MOD, XS_FIVE_DIGIT, XS_FIVE_DIGIT_MOD, XS_ONE_SIX_SERIES,
 XS_AC25_773, XS_NUM_TYPES) = range(21)
(SS_LINE, SS_RECTANGLE, SS_ELLIPSE, SS_CONTROL, SS_LINE_ARRAY, SS_FINITE_LINE,
 SS_XSEC_CURVE, SS_INTERSECT, SS_NUM_TYPES) = range(9)
(REORDER_MOVE_UP, REORDER_MOVE_DOWN, REORDER_MOVE_TOP, REORDER_MOVE_BOTTOM,
 NUM_REORDER_TYPES) = range(5)
# Keep in step with APIDefines.h XSEC_SIDES_TYPE.
XSEC_BOTH_SIDES, XSEC_LEFT_SIDE, XSEC_RIGHT_SIDE = range(3)


class OpenVSPError(RuntimeError):
    def __init__(self, message, outcome=None, actual=None, code=None):
        super().__init__(message)
        self.outcome, self.actual, self.code = outcome, actual, code


# Keep in step with LIVE_WRITES in syncProbe.ts.
_LIVE_WRITES = frozenset({
    'live_add_geom', 'live_delete_geom', 'live_update', 'live_parm_set', 'live_parm_set_by_id',
    'live_analysis_defaults', 'live_analysis_set_int', 'live_analysis_set_double', 'live_analysis_set_string', 'live_analysis_run', 'live_insert_xsec',
    'live_delete_xsec', 'live_insert_xsec_by_id', 'live_delete_xsec_by_id',
    'live_xsec_set_width', 'live_xsec_set_height', 'live_xsec_set_width_height',
    'live_xsec_set_alias', 'live_xsec_set_curve_alias', 'live_xsec_set_continuity',
    'live_xsec_set_tan_angles', 'live_xsec_set_tan_slews', 'live_xsec_set_tan_strengths',
    'live_xsec_set_curvatures',
    'live_change_xsec_shape', 'live_add_sub_surf', 'live_delete_sub_surf',
    'live_reorder_sub_surf', 'live_set_sub_surf_name', 'live_set_set_name', 'live_set_set_flag', 'read_file', 'write_file', 'import_file',
    'export_file', 'set_vsp_file_name', 'clear_model', 'live_delete_result',
    'live_delete_all_results', 'live_parm_set_update', 'live_set_geom_name',
    'live_update_geom', 'live_set_geom_parent', 'live_copy_geom', 'live_cut_geom', 'live_paste_geom',
    'live_geom_set_draw_type', 'live_geom_set_display_type', 'live_geom_set_wire_color',
    'live_geom_set_material',
    'live_parm_set_descript', 'live_parm_set_limits', 'live_clone_geom_vec', 'live_delete_geom_vec',
    'live_copy_paste_set',
})


def _call(operation, **arguments):
    write = operation in _LIVE_WRITES
    try:
        payload = json.dumps(arguments, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise OpenVSPError(str(exc), 'not_written' if write else None, code='INVALID_ARGUMENT') from exc
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
        outcome = error.get('outcome')
        if outcome not in ('not_written', 'unknown', 'different'):
            outcome = 'unknown' if write else None
        raise OpenVSPError(error['message'], outcome, error.get('actual'), error.get('code'))
    if 'value' not in response:
        raise OpenVSPError('Successful synchronous response has no value', 'unknown' if write else None, code='INVALID_RESPONSE')
    return response['value']


def get_instance(instance=None):
    if instance is not None and instance is not sys.modules[__name__]:
        raise ValueError('Multiple OpenVSP instances are not supported')
    return sys.modules[__name__]


# ---------------------------------------------------------------- geometry

def AddGeom(type, parent=''):
    return _call('live_add_geom', type=type, parent=parent)


CLONE_DELETE_LEAVE_EMPTY, CLONE_DELETE_WITH_ORIGINAL, CLONE_DELETE_REPLACE = 0, 1, 2
CLONE_DELETE_NUM_TYPES = 3


def DeleteGeom(geom_id, clone_delete=CLONE_DELETE_LEAVE_EMPTY):
    return _call('live_delete_geom', geom_id=geom_id, clone_delete=clone_delete)


def GetGeomTypes():
    return _call('live_geom_types')


def GetNumMainSurfs(geom_id):
    return _call('live_num_main_surfs', geom_id=geom_id)


def GetGeomDrawType(geom_id):
    return _call('live_geom_draw_type', geom_id=geom_id)


def SetGeomDrawType(geom_id, draw_type):
    if type(draw_type) is not int:
        raise ValueError('A draw type must be an integer')
    return _call('live_geom_set_draw_type', geom_id=geom_id, type=draw_type)


def GetGeomDisplayType(geom_id):
    return _call('live_geom_display_type', geom_id=geom_id)


def SetGeomDisplayType(geom_id, display_type):
    if type(display_type) is not int:
        raise ValueError('A display type must be an integer')
    return _call('live_geom_set_display_type', geom_id=geom_id, type=display_type)


def GetGeomWireColor(geom_id):
    return _call('live_geom_wire_color', geom_id=geom_id)


def SetGeomWireColor(geom_id, rgb):
    try:
        channels = [int(value) for value in rgb]
    except (TypeError, ValueError) as exc:
        raise ValueError('A wire colour needs three integer channels') from exc
    if len(channels) != 3 or any(value < 0 or value > 255 for value in channels):
        raise ValueError('Wire colour channels must be integers from 0 to 255')
    return _call('live_geom_set_wire_color', geom_id=geom_id, rgb=channels)


def GetGeomMaterialName(geom_id):
    return _call('live_geom_material', geom_id=geom_id)


def SetGeomMaterialName(geom_id, name):
    if not isinstance(name, str):
        raise ValueError('A material name is required')
    return _call('live_geom_set_material', geom_id=geom_id, name=name)


def GetGeomBBoxMin(geom_id, main_surf_ind=0, ref_frame_is_absolute=True):
    return _call('live_geom_bbox_min', geom_id=geom_id, surf=main_surf_ind,
                 absolute=bool(ref_frame_is_absolute))


def GetGeomBBoxMax(geom_id, main_surf_ind=0, ref_frame_is_absolute=True):
    return _call('live_geom_bbox_max', geom_id=geom_id, surf=main_surf_ind,
                 absolute=bool(ref_frame_is_absolute))


def CompPnt01(geom_id, surf_indx, u, w):
    return _Vec3d(_call('live_comp_pnt01', geom_id=geom_id, surf_indx=surf_indx, u=u, w=w))


def CompNorm01(geom_id, surf_indx, u, w):
    return _Vec3d(_call('live_comp_norm01', geom_id=geom_id, surf_indx=surf_indx, u=u, w=w))


def UpdateGeom(geom_id):
    return _call('live_update_geom', geom_id=geom_id)


def SetGeomParent(geom_id, parent_id):
    return _call('live_set_geom_parent', geom_id=geom_id, parent_id=parent_id)


def CopyGeomToClipboard(geom_id):
    return _call('live_copy_geom', geom_id=geom_id)


def CutGeomToClipboard(geom_id, clone_delete=CLONE_DELETE_LEAVE_EMPTY):
    return _call('live_cut_geom', geom_id=geom_id, clone_delete=clone_delete)


def PasteGeomClipboard(parent=''):
    return _call('live_paste_geom', parent=parent)


def CloneGeomVec(geom_ids, name_suffix='_Clone'):
    """Copy several geometries; returns the new IDs in input order."""
    if not isinstance(geom_ids, (list, tuple)) or not geom_ids:
        raise ValueError('A non-empty list of geometry IDs is required')
    for geom_id in geom_ids:
        if not isinstance(geom_id, str) or not geom_id:
            raise ValueError('Geometry IDs must be non-empty strings')
    if not isinstance(name_suffix, str):
        raise ValueError('A clone name suffix is required')
    return _call('live_clone_geom_vec', geom_ids=list(geom_ids), name_suffix=name_suffix)


def DeleteGeomVec(geom_ids, clone_delete=CLONE_DELETE_LEAVE_EMPTY):
    if not isinstance(geom_ids, (list, tuple)) or not geom_ids:
        raise ValueError('A non-empty list of geometry IDs is required')
    for geom_id in geom_ids:
        if not isinstance(geom_id, str) or not geom_id:
            raise ValueError('Geometry IDs must be non-empty strings')
    return _call('live_delete_geom_vec', geom_ids=list(geom_ids), clone_delete=clone_delete)


def CopyPasteSet(copy_index, paste_index):
    """Copy every geometry of one set into another set, as the GUI does."""
    for index in (copy_index, paste_index):
        if type(index) is not int or index < 0:
            raise ValueError('Set indices must be non-negative integers')
    return _call('live_copy_paste_set', copy_index=copy_index, paste_index=paste_index)


def GetGeomSetCollection(index):
    """Attribute collection ID attached to a set ('' when it has none)."""
    if type(index) is not int or index < 0:
        raise ValueError('Set index must be a non-negative integer')
    return _call('live_geom_set_collection', index=index)


def Update(update_managers=True):
    return _call('live_update', update_managers=bool(update_managers))


# ---------------------------------------------------------------- files

# Relative paths live here: the page mounts the user's chosen folder (or added
# files) into this directory of the engine's file system.
WORKSPACE_ROOT = '/work'

SET_NONE, SET_ALL, SET_SHOWN, SET_NOT_SHOWN = -1, 0, 1, 2

# Keep in step with APIDefines.h. EXPORT_STEP is unavailable in this build.
EXPORT_FELISA, EXPORT_XSEC, EXPORT_STL, EXPORT_AWAVE, EXPORT_NASCART = 0, 1, 2, 3, 4
EXPORT_POVRAY, EXPORT_CART3D, EXPORT_VSPGEOM, EXPORT_VORXSEC, EXPORT_XSECGEOM = 5, 6, 7, 8, 9
EXPORT_GMSH, EXPORT_X3D, EXPORT_STEP, EXPORT_PLOT3D, EXPORT_IGES = 10, 11, 12, 13, 14
EXPORT_BEM, EXPORT_DXF, EXPORT_FACET, EXPORT_SVG, EXPORT_PMARC = 15, 16, 17, 18, 19
EXPORT_OBJ, EXPORT_SELIG_AIRFOIL, EXPORT_BEZIER_AIRFOIL = 20, 21, 22
EXPORT_IGES_STRUCTURE, EXPORT_STEP_STRUCTURE, EXPORT_STEP_STITCH, EXPORT_IGES_STITCH = 23, 24, 25, 26

IMPORT_STL, IMPORT_NASCART, IMPORT_CART3D_TRI, IMPORT_XSEC_MESH = 0, 1, 2, 3
IMPORT_PTS, IMPORT_V2, IMPORT_BEM, IMPORT_XSEC_WIRE, IMPORT_P3D_WIRE = 4, 5, 6, 7, 8


def _resolve_path(file_name):
    """Absolute engine paths pass through; relative names resolve in /work.

    ``..`` is rejected so a relative name cannot climb out of the workspace.
    """
    if not isinstance(file_name, str) or not file_name.strip():
        raise ValueError('A file path is required')
    text = file_name.strip()
    if text.startswith('/'):
        return text
    parts = []
    for segment in text.replace('\\', '/').split('/'):
        if segment in ('', '.'):
            continue
        if segment == '..':
            raise ValueError('Path escapes the Python workspace')
        parts.append(segment)
    if not parts:
        raise ValueError('A file name is required')
    return WORKSPACE_ROOT + '/' + '/'.join(parts)


def ReadVSPFile(file_name):
    """Clear the model and load a ``.vsp3`` file from the engine file system.

    Relative names resolve inside the Python workspace (``/work``). Mount a
    folder in the Python console first; ``GetVSPFileName()`` returns an absolute
    path that always works.
    """
    return _call('read_file', path=_resolve_path(file_name))


def WriteVSPFile(file_name, set=SET_ALL):
    """Write the whole model to a path, as Save As (also sets the model file name)."""
    if set != SET_ALL:
        raise ValueError('Only SET_ALL is supported for WriteVSPFile')
    return _call('write_file', path=_resolve_path(file_name))


def ExportFile(file_name, set=SET_ALL, file_type=EXPORT_STL, subs_flag=1,
               thin_set=SET_NONE, use_mode=False, mode_id=''):
    """Export geometry to a path in the engine file system.

    Only the native default optional arguments are supported; STEP export is not
    built in this WebAssembly build.
    """
    if subs_flag != 1 or thin_set != SET_NONE or use_mode or mode_id:
        raise ValueError('Only the default ExportFile options are supported')
    return _call('export_file', path=_resolve_path(file_name), file_type=int(file_type), set=set)


def ImportFile(file_name, file_type=IMPORT_STL, parent=''):
    """Import a file into the model; returns the new Geometry ID."""
    if parent:
        raise ValueError('Importing under a parent geometry is not supported')
    return _call('import_file', path=_resolve_path(file_name), file_type=int(file_type))


def SetVSP3FileName(file_name):
    """Set the model's file name (used by Save/Export defaults); writes nothing."""
    return _call('set_vsp_file_name', path=_resolve_path(file_name))


def GetVSPFileName():
    """Return the model's current file name (an absolute engine path)."""
    return _call('get_vsp_file_name')


def ClearVSPModel():
    """Remove every geometry and result from the model."""
    return _call('clear_model')


def FindGeoms():
    return _call('find_geoms')


def FindGeom(name, index=0):
    if not isinstance(name, str) or not name:
        raise ValueError('A geometry name is required')
    if type(index) is not int or index < 0:
        raise ValueError('Geometry index must be a non-negative integer')
    return _call('find_geom', name=name, index=index)


def GetGeomName(geom_id):
    return _call('geom_name', geom_id=geom_id)


def GetGeomTypeName(geom_id):
    return _call('geom_type', geom_id=geom_id)


def GetGeomParent(geom_id):
    """Parent geometry ID; top-level geometries return 'NONE' (native semantics)."""
    return _call('geom_parent', geom_id=geom_id)


def GetGeomChildren(geom_id):
    """Direct child geometry IDs in model order (empty for a leaf)."""
    return _call('geom_children', geom_id=geom_id)


def SetGeomName(geom_id, name):
    """Rename a geometry and update the model (native refusal rules apply)."""
    if not isinstance(geom_id, str) or not geom_id:
        raise ValueError('A geometry ID is required')
    if not isinstance(name, str) or not name:
        raise ValueError('A geometry name is required')
    if len(name.encode('utf-8')) > 256:
        raise ValueError('Geometry name must be at most 256 UTF-8 bytes')
    _call('live_set_geom_name', geom_id=geom_id, name=name)
    return None


def GetGeomParmIDs(geom_id):
    return _call('geom_parm_ids', geom_id=geom_id)


def _parm_id_required(parm_id, label='Parameter ID'):
    if not isinstance(parm_id, str) or not parm_id:
        raise ValueError(label + ' is required')
    return parm_id


def GetParmVal(*args):
    """Read a parameter by ID, or by geometry/name/group (native overloads)."""
    if len(args) == 1:
        return _call('live_parm_value_by_id', parm_id=_parm_id_required(args[0]))
    if len(args) == 3:
        geom_id, name, group = args
        return _call('live_parm_get', geom_id=geom_id, key=group + '\x1f' + name)
    raise TypeError('GetParmVal expects (parm_id) or (geom_id, name, group)')


def GetParm(geom_id, name, group):
    """Native alias of FindParm: parm ID on a geometry ('' when absent)."""
    return FindParm(geom_id, name, group)


def GetParmType(parm_id):
    return _call('live_parm_type', parm_id=_parm_id_required(parm_id))


def GetParmLowerLimit(parm_id):
    """Lower limit, or None when the parameter is unbounded."""
    return _call('live_parm_limits', parm_id=_parm_id_required(parm_id))['lower']


def GetParmUpperLimit(parm_id):
    """Upper limit, or None when the parameter is unbounded."""
    return _call('live_parm_limits', parm_id=_parm_id_required(parm_id))['upper']


def GetParmActiveFlag(parm_id):
    return _call('live_parm_active', parm_id=_parm_id_required(parm_id))


def FindParm(container_id, name, group):
    """Return the parameter ID, or '' when not found.

    ``group`` is the internal group name (see ``GetParmGroupName``); the display
    group in ``GetParmInfo`` may differ when a suffix or alias is present.
    """
    if not isinstance(container_id, str) or not container_id:
        raise ValueError('A parameter container ID is required')
    if not isinstance(name, str) or not name or not isinstance(group, str) or not group:
        raise ValueError('A parameter name and group are required')
    return _call('live_parm_find', container_id=container_id, key=group + '\x1f' + name)


def GetParmName(parm_id):
    return _call('live_parm_name', parm_id=_parm_id_required(parm_id))


def GetParmGroupName(parm_id):
    """Internal group name used by FindParm/GetParmVal."""
    return _call('live_parm_group', parm_id=_parm_id_required(parm_id))


def GetParmDisplayGroupName(parm_id):
    """Display group name (the ``group`` field of GetParmInfo)."""
    return _call('live_parm_display_group', parm_id=_parm_id_required(parm_id))


def GetParmDescript(parm_id):
    return _call('live_parm_descript', parm_id=_parm_id_required(parm_id))


def SetParmDescript(parm_id, description):
    if not isinstance(description, str):
        raise ValueError('A parameter description is required')
    return _call('live_parm_set_descript', parm_id=_parm_id_required(parm_id), description=description)


def GetParmContainer(parm_id):
    """ID of the parm container that owns this parameter."""
    return _call('live_parm_container', parm_id=_parm_id_required(parm_id))


def SetParmValLimits(parm_id, value, lower_limit, upper_limit):
    """Set a value together with its limits; returns the value actually taken."""
    numbers = []
    for item in (value, lower_limit, upper_limit):
        if type(item) not in (int, float) or item != item or item in (float('inf'), float('-inf')):
            raise ValueError('Parameter values and limits must be finite numbers')
        numbers.append(float(item))
    return _call('live_parm_set_limits', parm_id=_parm_id_required(parm_id), values=numbers)


def SetParmValUpdate(*args):
    """Set a parameter and update the model (native SetParmValUpdate overloads).

    Accepts ``(parm_id, value)`` or ``(geom_id, name, group, value)``. Unlike
    ``SetParmVal``/``SetParmValByID`` this triggers an update, and unlike the
    engine's validated page path it does not pre-check limits or the active flag.
    """
    if len(args) == 2:
        parm_id, value = args
        parm_id = _parm_id_required(parm_id)
    elif len(args) == 4:
        geom_id, name, group, value = args
        parm_id = FindParm(geom_id, name, group)
        if not parm_id:
            raise OpenVSPError('Parameter not found: %s/%s' % (group, name))
    else:
        raise TypeError('SetParmValUpdate expects (parm_id, value) or (geom_id, name, group, value)')
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError('Parameter value must be a number') from exc
    return _call('live_parm_set_update', parm_id=parm_id, value=number)


def SetParmVal(geom_id, name, group=None, value=None):
    if group is None and value is None:
        return _call('live_parm_set_by_id', parm_id=geom_id, value=float(name))
    if group is None or value is None:
        raise TypeError('SetParmVal expects (parm_id, value) or (geom_id, name, group, value)')
    return _call('live_parm_set', geom_id=geom_id, key=group + '\x1f' + name, value=float(value))


# ---------------------------------------------------------------- XSec / subsurface

def GetNumXSecSurfs(geom_id):
    return len(_call('live_xsec_surfs', geom_id=geom_id))


def _indexed_id(ids, index):
    # OpenVSP indices are nonnegative, unlike Python sequence indices.
    import operator
    index = operator.index(index)
    if index < 0:
        raise IndexError('OpenVSP index out of range')
    return ids[index]


def GetXSecSurf(geom_id, index):
    return _indexed_id(_call('live_xsec_surfs', geom_id=geom_id), index)


def GetXSecSurfIDVec(geom_id):
    return _call('live_xsec_surf_ids', geom_id=geom_id)


def GetXSecSurfIDs(geom_id):
    return _call('live_xsec_surfs', geom_id=geom_id)


def GetNumXSec(xsec_surf_id):
    return len(_call('live_xsecs', xsec_surf_id=xsec_surf_id))


def GetXSec(xsec_surf_id, index):
    return _indexed_id(_call('live_xsecs', xsec_surf_id=xsec_surf_id), index)


def GetXSecIDVec(xsec_surf_id):
    return _call('live_xsec_ids', xsec_surf_id=xsec_surf_id)


def GetXSecIDs(xsec_surf_id):
    return GetXSecIDVec(xsec_surf_id)


def GetXSecShape(xsec_id):
    return _call('live_xsec_shape', xsec_id=xsec_id)


def GetXSecParmIDs(xsec_id):
    return _call('live_xsec_parm_ids', xsec_id=xsec_id)


def GetXSecParm(xsec_id, name):
    return _call('live_xsec_parm', xsec_id=xsec_id, name=name)


def GetXSecAlias(xsec_id):
    return _call('live_xsec_alias', xsec_id=xsec_id)


def SetXSecAlias(xsec_id, alias):
    return _call('live_xsec_set_alias', xsec_id=xsec_id, alias=alias)


def GetXSecCurveAlias(xsec_id):
    return _call('live_xsec_curve_alias', xsec_id=xsec_id)


def SetXSecCurveAlias(xsec_id, alias):
    return _call('live_xsec_set_curve_alias', xsec_id=xsec_id, alias=alias)


def GetXSecContinuity(xsec_id):
    return _call('live_xsec_continuity', xsec_id=xsec_id)


def SetXSecContinuity(xsec_id, continuity):
    if type(continuity) is not int:
        raise ValueError('XSec continuity must be an integer')
    return _call('live_xsec_set_continuity', xsec_id=xsec_id, continuity=continuity)


def _get_xsec_curve_values(kind, xsec_id, side):
    if type(side) is not int:
        raise ValueError('XSec side must be an integer')
    return _call('live_xsec_' + kind, xsec_id=xsec_id, side=side)


def _set_xsec_curve_values(kind, xsec_id, side, values):
    if type(side) is not int:
        raise ValueError('XSec side must be an integer')
    if len(values) != 4:
        raise ValueError('Four curve values (top, right, bottom, left) are required')
    fields = []
    for value in values:
        if type(value) not in (int, float) or value != value or value in (float('inf'), float('-inf')):
            raise ValueError('XSec curve values must be finite numbers')
        fields.append(float(value))
    return _call('live_xsec_set_' + kind, xsec_id=xsec_id, side=side, fields=fields)


def GetXSecTanAngles(xsec_id, side):
    return _get_xsec_curve_values('tan_angles', xsec_id, side)


def SetXSecTanAngles(xsec_id, side, top, right, bottom, left):
    return _set_xsec_curve_values('tan_angles', xsec_id, side, (top, right, bottom, left))


def GetXSecTanSlews(xsec_id, side):
    return _get_xsec_curve_values('tan_slews', xsec_id, side)


def SetXSecTanSlews(xsec_id, side, top, right, bottom, left):
    return _set_xsec_curve_values('tan_slews', xsec_id, side, (top, right, bottom, left))


def GetXSecTanStrengths(xsec_id, side):
    return _get_xsec_curve_values('tan_strengths', xsec_id, side)


def SetXSecTanStrengths(xsec_id, side, top, right, bottom, left):
    return _set_xsec_curve_values('tan_strengths', xsec_id, side, (top, right, bottom, left))


def GetXSecCurvatures(xsec_id, side):
    return _get_xsec_curve_values('curvatures', xsec_id, side)


def SetXSecCurvatures(xsec_id, side, top, right, bottom, left):
    return _set_xsec_curve_values('curvatures', xsec_id, side, (top, right, bottom, left))


def GetXSecWidth(xsec_id):
    return _call('live_xsec_width', xsec_id=xsec_id)


def GetXSecHeight(xsec_id):
    return _call('live_xsec_height', xsec_id=xsec_id)


def SetXSecWidth(xsec_id, width):
    return _call('live_xsec_set_width', xsec_id=xsec_id, width=float(width))


def SetXSecHeight(xsec_id, height):
    return _call('live_xsec_set_height', xsec_id=xsec_id, height=float(height))


def SetXSecWidthHeight(xsec_id, width, height):
    return _call('live_xsec_set_width_height', xsec_id=xsec_id, width=float(width), height=float(height))


def InsertXSec(geom_id, index, type):
    return _call('live_insert_xsec', geom_id=geom_id, index=index, shape=type)


def InsertXSecByID(xsec_id, type):
    return _call('live_insert_xsec_by_id', xsec_id=xsec_id, shape=type)


def CutXSec(geom_id, index):
    return _call('live_delete_xsec', xsec_surf_id=geom_id, index=index)


def CutXSecByID(xsec_id):
    return _call('live_delete_xsec_by_id', xsec_id=xsec_id)


def CopyXSec(geom_id, index):
    return _call('live_copy_xsec', geom_id=geom_id, index=index)


def CopyXSecByID(xsec_id):
    return _call('live_copy_xsec_by_id', xsec_id=xsec_id)


def PasteXSec(geom_id, index):
    return _call('live_paste_xsec', geom_id=geom_id, index=index)


def PasteXSecByID(xsec_id):
    return _call('live_paste_xsec_by_id', xsec_id=xsec_id)


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


def GetSubSurf(geom_id, index_or_name):
    """Return a sub-surface ID by index, or all IDs with a matching name."""
    if isinstance(index_or_name, str):
        return _call('live_sub_surfs_by_name', geom_id=geom_id, name=index_or_name)
    return _indexed_id(GetSubSurfIDVec(geom_id), index_or_name)


def AddSubSurf(geom_id, type, surfindex=0):
    return _call('live_add_sub_surf', geom_id=geom_id, type=type, surf_index=surfindex)


def DeleteSubSurf(*args):
    """Delete by ``(geom_id, sub_id)`` or the native ``(sub_id,)`` overload."""
    if len(args) == 1:
        return _call('live_delete_sub_surf', sub_id=args[0])
    if len(args) == 2:
        return _call('live_delete_sub_surf', geom_id=args[0], sub_id=args[1])
    raise TypeError('DeleteSubSurf expects (sub_id) or (geom_id, sub_id)')


def ReorderSubSurf(geom_id, sub_id, reorder_type):
    return _call('live_reorder_sub_surf', geom_id=geom_id, sub_id=sub_id, reorder_type=reorder_type)


def GetSubSurfType(sub_id):
    return _call('live_sub_surf_type', sub_id=sub_id)


def GetSubSurfParmIDs(sub_id):
    return _call('live_sub_surf_parm_ids', sub_id=sub_id)


def GetSubSurfName(*args):
    if len(args) == 1:
        return _call('live_sub_surf_name', sub_id=args[0])
    if len(args) == 2:
        return _call('live_sub_surf_name', geom_id=args[0], sub_id=args[1])
    raise TypeError('GetSubSurfName expects (sub_id) or (geom_id, sub_id)')


def SetSubSurfName(*args):
    if len(args) == 2:
        return _call('live_set_sub_surf_name', sub_id=args[0], name=args[1])
    if len(args) == 3:
        return _call('live_set_sub_surf_name', geom_id=args[0], sub_id=args[1], name=args[2])
    raise TypeError('SetSubSurfName expects (sub_id, name) or (geom_id, sub_id, name)')


def GetSubSurfIndex(sub_id):
    return _call('live_sub_surf_index', sub_id=sub_id)


def GetAllSubSurfIDs():
    return _call('live_all_sub_surfs')


# ---------------------------------------------------------------- sets

def GetNumSets():
    return _call('live_num_sets')


def GetSetName(index):
    return _call('live_set_name', index=index)


def GetSetNames():
    return [GetSetName(i) for i in range(GetNumSets())]


def SetSetName(index, name):
    return _call('live_set_set_name', index=index, name=name)


def GetSetIndex(name):
    """Index of a named set, or -1 when it does not exist."""
    if not isinstance(name, str) or not name:
        raise ValueError('A set name is required')
    return _call('live_set_index', name=name)


def GetGeomSet(name):
    """Geometry IDs in a named set."""
    if not isinstance(name, str) or not name:
        raise ValueError('A set name is required')
    return _call('live_geom_set', name=name)


def GetGeomSetAtIndex(index):
    """Geometry IDs in the set at this index."""
    if type(index) is not int or index < 0:
        raise ValueError('Set index must be a non-negative integer')
    return _call('live_geom_set_at_index', index=index)


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

def ListAnalysis():
    """Names of every analysis the engine knows (not all are callable here)."""
    return _call('live_list_analysis')


def GetAnalysisInputNames(analysis):
    if not isinstance(analysis, str) or not analysis:
        raise ValueError('An analysis name is required')
    return _call('live_analysis_input_names', analysis=analysis)


def GetAnalysisInputType(analysis, name):
    """RES_DATA_TYPE of an analysis input (-1 when unknown)."""
    if not isinstance(analysis, str) or not analysis:
        raise ValueError('An analysis name is required')
    if not isinstance(name, str) or not name:
        raise ValueError('An analysis input name is required')
    return _call('live_analysis_input_type', analysis=analysis, name=name)


def SetAnalysisInputDefaults(analysis):
    return _call('live_analysis_defaults', analysis=analysis)


def _get_analysis_input(kind, analysis, name, index):
    if type(index) is not int or not 0 <= index <= 2147483647:
        raise ValueError('Analysis input index must be a non-negative 32-bit integer')
    return _call('live_analysis_get_' + kind, analysis=analysis, name=name, index=index)


def GetIntAnalysisInput(analysis, name, index=0):
    return _get_analysis_input('int', analysis, name, index)


def GetDoubleAnalysisInput(analysis, name, index=0):
    return _get_analysis_input('double', analysis, name, index)


def GetStringAnalysisInput(analysis, name, index=0):
    return _get_analysis_input('string', analysis, name, index)


def _set_analysis_input(kind, analysis, name, values, index):
    if type(index) is not int or not 0 <= index <= 2147483647:
        raise ValueError('Analysis input index must be a non-negative 32-bit integer')
    if not isinstance(analysis, str) or not analysis:
        raise ValueError('An analysis name is required')
    if not isinstance(name, str) or not name or '\0' in name:
        raise ValueError('An analysis input name is required')
    if not isinstance(values, (list, tuple)):
        raise ValueError('Analysis input values must be a list or tuple')
    items = list(values)
    if kind == 'int':
        for value in items:
            if type(value) is not int or not -2147483648 <= value <= 2147483647:
                raise ValueError('Expected 32-bit integer analysis input values')
        items = [int(value) for value in items]
    elif kind == 'double':
        for value in items:
            if type(value) not in (int, float):
                raise ValueError('Expected numeric analysis input values')
        items = [float(value) for value in items]
    else:
        for value in items:
            if not isinstance(value, str) or '\0' in value:
                raise ValueError('Expected string analysis input values without NUL')
    return _call('live_analysis_set_' + kind, analysis=analysis, name=name,
                 index=index, values=items)


def SetIntAnalysisInput(analysis, name, values, index=0):
    return _set_analysis_input('int', analysis, name, values, index)


def SetDoubleAnalysisInput(analysis, name, values, index=0):
    return _set_analysis_input('double', analysis, name, values, index)


def SetStringAnalysisInput(analysis, name, values, index=0):
    return _set_analysis_input('string', analysis, name, values, index)


def ExecAnalysis(analysis):
    return _call('live_analysis_run', analysis=analysis)


# ---------------------------------------------------------------- results

def GetAllResultsIDs():
    return _call('live_results_ids')


def GetAllResultsNames():
    """Return the distinct names of results currently in the ResultsMgr."""
    return _call('live_results_names')


def FindResultsID(name, index=0):
    """Return the ID of the index-th result with this name, or '' if absent."""
    if not isinstance(name, str) or not name:
        raise ValueError('A result name is required')
    if type(index) is not int or index < 0:
        raise ValueError('Result index must be a non-negative integer')
    return _call('live_find_results_id', name=name, index=index)


def FindLatestResultsID(name):
    """Return the ID of the newest result with this name, or '' if absent."""
    if not isinstance(name, str) or not name:
        raise ValueError('A result name is required')
    return _call('live_find_latest_results_id', name=name)


def GetNumResults(name):
    """Return how many results with this name are stored."""
    if not isinstance(name, str) or not name:
        raise ValueError('A result name is required')
    return _call('live_num_results', name=name)


def DeleteResult(result_id):
    """Delete one result by ID; unknown IDs are ignored by the ResultsMgr."""
    if not isinstance(result_id, str) or not result_id:
        raise ValueError('A result ID is required')
    return _call('live_delete_result', result_id=result_id)


def DeleteAllResults():
    """Delete every result in the ResultsMgr."""
    return _call('live_delete_all_results')


def GetResultSnapshotCapabilities():
    """Return bridge capabilities; callers must not infer IDs or consistency."""
    return _call('live_result_objects_capabilities')


def GetResultSnapshots(result_ids, fallback=False):
    """Explicit IDs only. Fallback uses separate jobs and is not a snapshot."""
    if not isinstance(result_ids, (list, tuple)) or not 1 <= len(result_ids) <= 32:
        raise ValueError('At most 32 explicit result IDs are supported')
    ids = list(result_ids)
    if any(not isinstance(x, str) or not 1 <= len(x) <= 128 or not all(33 <= ord(c) <= 126 for c in x) for x in ids):
        raise ValueError('Result IDs must be printable ASCII strings of 1..128 bytes')
    raw = request('live_result_objects', json.dumps({'result_ids': ids}, allow_nan=False))
    if isinstance(raw, str):
        envelope = json.loads(raw)
        error = envelope.get('error') or {}
        if fallback and not envelope.get('ok') and (error.get('code') == 'UNSUPPORTED_OPERATION' or error.get('message') in ('Unsupported live operation', 'Unknown operation', 'unknown request: liveResultObjects')):
            out = []
            for result_id in ids:
                try:
                    entry = _batch_result_cache(result_id)
                    out.append({'id': result_id, 'status': 'ok', 'data': entry} if entry is not None else {'id': result_id, 'status': 'over_limit_or_unsupported'})
                except OpenVSPError as exc:
                    if str(exc) != 'Unknown result ID':
                        raise
                    out.append({'id': result_id, 'status': 'unknown'})
            return out
        raise OpenVSPError((envelope.get('error') or {}).get('message', 'Batch result read failed'))
    data = bytes(raw.to_py() if hasattr(raw, 'to_py') else raw)
    if len(data) > 512 * 1024 or len(data) < 8 or data[:4] != b'VRM1':
        raise OpenVSPError('Invalid batch result header')
    count = struct.unpack_from('<I', data, 4)[0]
    if count != len(ids):
        raise OpenVSPError('Batch result count mismatch')
    pos, out = 8, []
    for result_id in ids:
        if pos + 8 > len(data): raise OpenVSPError('Truncated batch result')
        status, size = struct.unpack_from('<II', data, pos); pos += 8
        if status == 1 and size == 0: out.append({'id': result_id, 'status': 'unknown'})
        elif status == 2 and size == 0: out.append({'id': result_id, 'status': 'over_limit_or_unsupported'})
        elif status == 0 and size >= 12 and size <= 512 * 1024 and pos + size <= len(data):
            payload = data[pos:pos + size]; pos += size
            # Reuse the strict VRO1 decoder without another bridge request.
            try:
                entry = _decode_vro1(payload)
            except ValueError as exc:
                raise OpenVSPError('Malformed VRO1 result payload') from exc
            if entry is None:
                raise OpenVSPError('Malformed VRO1 result payload')
            out.append({'id': result_id, 'status': 'ok', 'data': entry})
        else: raise OpenVSPError('Invalid batch result item')
    if pos != len(data): raise OpenVSPError('Trailing batch result bytes')
    return out


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


def GetIntResults(result_id, data_name, index=0):
    return _numeric_values(result_id, data_name, index, INT_DATA)


def GetBinaryResults(result_id, data_name, index=0):
    """Read bounded binary chunks, preserving IEEE-754 values and ragged rows."""
    return _binary_results(result_id, data_name, index, None)


def _binary_results(result_id, data_name, index, wanted_kind):
    result, row, offset, expected_kind, expected_rows, row_length = [], 0, 0, None, None, None
    string_bytes = bytearray()
    while True:
        raw = request('live_result_binary_field', json.dumps({'result_id': result_id, 'name': data_name, 'index': index, 'row': row, 'offset': offset}, allow_nan=False))
        if isinstance(raw, str):
            response = json.loads(raw)
            raise OpenVSPError((response.get('error') or {}).get('message', 'Binary result failed'))
        data = bytes(raw.to_py() if hasattr(raw, 'to_py') else raw)
        if len(data) < 28 or data[:4] != b'VRB2':
            raise OpenVSPError('Invalid binary result header')
        kind, rows, actual_row, length, actual_offset, count = struct.unpack_from('<6I', data, 4)
        if kind not in (INT_DATA, INT_MATRIX_DATA, DOUBLE_DATA, DOUBLE_MATRIX_DATA, VEC3D_DATA, STRING_DATA):
            raise OpenVSPError('Unsupported binary result type')
        if wanted_kind is not None and kind != wanted_kind and expected_kind is None:
            return []
        if expected_kind is None:
            expected_kind, expected_rows = kind, rows
            if kind in (INT_DATA, DOUBLE_DATA) and rows != 1:
                raise OpenVSPError('Invalid binary result shape')
        if kind != expected_kind or rows != expected_rows or actual_row != row or actual_offset != offset or row > rows:
            raise OpenVSPError('Inconsistent binary result chunk')
        if row_length is not None and length != row_length:
            raise OpenVSPError('Result changed during binary read')
        if row == rows and (rows != 0 or length != 0 or count != 0):
            raise OpenVSPError('Invalid empty binary result')
        if kind == VEC3D_DATA and row < rows and length != 3:
            raise OpenVSPError('Invalid vector result shape')
        size, fmt = (1, None) if kind == STRING_DATA else ((4, 'i') if kind in (INT_DATA, INT_MATRIX_DATA) else (8, 'd'))
        if offset > length or count != min(4096, length - offset) or len(data) != 28 + count * size:
            raise OpenVSPError('Invalid binary result chunk length')
        if kind == STRING_DATA and offset + count > length:
            raise OpenVSPError('Invalid string byte range')
        if row == rows:
            return []
        if kind == STRING_DATA:
            string_bytes.extend(data[28:])
        else:
            if offset == 0:
                result.append([])
            result[-1].extend(struct.unpack_from('<%d%s' % (count, fmt), data, 28))
        offset += count
        row_length = length
        if offset == length:
            if kind == STRING_DATA:
                try:
                    result.append(string_bytes.decode('utf-8'))
                except UnicodeDecodeError as exc:
                    raise OpenVSPError('Invalid UTF-8 in binary result') from exc
                string_bytes = bytearray()
            row += 1
            offset, row_length = 0, None
            if row == rows:
                return result[0] if kind in (INT_DATA, DOUBLE_DATA) else result


def _numeric_values(result_id, data_name, index, kind):
    cached = _meta(result_id)
    key = (data_name, int(index), kind)
    if cached is not None and key in cached['values']:
        return cached['values'][key]
    # A valid field of another type has the same empty result as before.
    value = _binary_results(result_id, data_name, index, kind)
    if cached is not None:
        cached['values'][key] = value
    return value


def GetDoubleResults(result_id, data_name, index=0):
    return _numeric_values(result_id, data_name, index, DOUBLE_DATA)


def GetStringResults(result_id, data_name, index=0):
    return _numeric_values(result_id, data_name, index, STRING_DATA)


def GetDoubleMatResults(result_id, data_name, index=0):
    return _numeric_values(result_id, data_name, index, DOUBLE_MATRIX_DATA)


def _decode_vro1(data):
    try:
        if len(data) > 512 * 1024 or data[:4] != b'VRO1': raise ValueError('invalid VRO1 header')
        pos = 4
        def number():
            nonlocal pos
            if pos + 4 > len(data): raise ValueError('truncated number')
            value, = struct.unpack_from('<I', data, pos); pos += 4; return value
        def text():
            nonlocal pos
            size = number()
            if size > len(data) - pos: raise ValueError('truncated string')
            value = data[pos:pos + size].decode('utf-8'); pos += size; return value
        def vector(fmt):
            nonlocal pos
            n = number(); size = struct.calcsize(fmt)
            if n > 32768 or n > (len(data) - pos) // size: raise ValueError('invalid vector size')
            add_items(n)
            values = list(struct.unpack_from('<%d%s' % (n, fmt), data, pos)); pos += n * size; return values
        name, count = text(), number()
        if count > 1024: raise ValueError('too many fields')
        entry = {'names': [], 'name': name, 'types': {}, 'values': {}}
        items = 0
        def add_items(n):
            nonlocal items
            if n > 32768 - items: raise ValueError('too many aggregate items')
            items += n
        for _ in range(count):
            field, kind = text(), number()
            if field in entry['types']: return None
            if kind == INT_DATA: value = vector('i')
            elif kind == DOUBLE_DATA: value = vector('d')
            elif kind == STRING_DATA:
                n = number()
                if n > 32768: raise ValueError('too many values')
                add_items(n)
                value = [text() for _ in range(n)]
            elif kind == DOUBLE_MATRIX_DATA:
                n = number()
                if n > 32768: raise ValueError('too many values')
                add_items(n)
                value = [vector('d') for _ in range(n)]
            elif kind == VEC3D_DATA:
                n = number()
                if n > 32768 or n > (len(data) - pos) // 24: return None
                add_items(n)
                value = [list(struct.unpack_from('<3d', data, pos + 24 * i)) for i in range(n)]; pos += n * 24
            else: return None
            entry['names'].append(field); entry['types'][field] = kind; entry['values'][(field, 0, kind)] = value
        return entry if pos == len(data) else None
    except (UnicodeDecodeError, struct.error, OverflowError) as exc:
        raise ValueError('invalid VRO1 payload') from exc


def _batch_result_cache(res_id):
    """Decode one VRO1 object; malformed/unsupported data safely falls back."""
    raw = request('live_result_object', json.dumps({'result_id': res_id}, allow_nan=False))
    if isinstance(raw, str):
        envelope = json.loads(raw)
        if not envelope.get('ok'):
            raise OpenVSPError((envelope.get('error') or {}).get('message', 'Result object read failed'))
        return None
    data = bytes(raw.to_py() if hasattr(raw, 'to_py') else raw)
    if len(data) > 512 * 1024 or data[:4] != b'VRO1': return None
    try:
        return _decode_vro1(data)
    except (ValueError, UnicodeDecodeError, struct.error, OverflowError):
        return None


def parse_results_object(res_id, vsp_instance=None):
    """Desktop parser, with an operation-scoped cache that cannot go stale later."""
    import openvsp_utilities
    # Preserve the facade's instance validation before any bridge request.
    get_instance(vsp_instance)
    global _RESULT_PARSE_CACHE
    previous = _RESULT_PARSE_CACHE
    if previous is None:
        _RESULT_PARSE_CACHE = {}
    try:
        if res_id not in _RESULT_PARSE_CACHE:
            try:
                entry = _batch_result_cache(res_id)
                if entry is not None:
                    _RESULT_PARSE_CACHE[res_id] = entry
            except OpenVSPError:
                # Older engines and unsupported snapshots use the original reads.
                pass
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

    def __repr__(self):
        return 'vec3d(%r, %r, %r)' % (self._xyz[0], self._xyz[1], self._xyz[2])


def GetVec3dResults(result_id, data_name, index=0):
    return [_Vec3d(p) for p in _numeric_values(result_id, data_name, index, VEC3D_DATA)]
