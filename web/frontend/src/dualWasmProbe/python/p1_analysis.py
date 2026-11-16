"""Snapshot-backed, deliberately narrow adapter for the two P1 analysis helpers.

The host supplies p1_snapshot.get_snapshot(analysis), returning a JSON string.
This is not a general OpenVSP binding and never runs arbitrary analyses.
"""
import importlib
import json
import math
import sys
import types

SET_ALL = 0
INT_DATA, DOUBLE_DATA, STRING_DATA, VEC3D_DATA, INT_MATRIX_DATA, DOUBLE_MATRIX_DATA = 1, 2, 3, 4, 5, 6
_ANALYSES = ('DegenGeom', 'SurfacePatches')


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _validate_value(kind, value):
    if not isinstance(value, list):
        raise ValueError('Result values must be arrays')
    checks = {
        INT_DATA: lambda x: type(x) is int,
        DOUBLE_DATA: _number,
        STRING_DATA: lambda x: isinstance(x, str),
        VEC3D_DATA: lambda x: isinstance(x, list) and len(x) == 3 and all(map(_number, x)),
        INT_MATRIX_DATA: lambda x: isinstance(x, list) and all(type(item) is int for item in x),
        DOUBLE_MATRIX_DATA: lambda x: isinstance(x, list) and all(map(_number, x)),
    }
    if kind not in checks or not all(map(checks[kind], value)):
        raise ValueError('Unsupported or invalid result value for type %s' % kind)
    return sum(len(item) for item in value) if kind in (VEC3D_DATA, INT_MATRIX_DATA, DOUBLE_MATRIX_DATA) else len(value)


class _Vec3d:
    def __init__(self, xyz):
        self._xyz = xyz

    def x(self): return self._xyz[0]
    def y(self): return self._xyz[1]
    def z(self): return self._xyz[2]


class SnapshotFacade(types.ModuleType):
    SET_ALL = SET_ALL
    INT_DATA, DOUBLE_DATA, STRING_DATA = INT_DATA, DOUBLE_DATA, STRING_DATA
    VEC3D_DATA, INT_MATRIX_DATA, DOUBLE_MATRIX_DATA = VEC3D_DATA, INT_MATRIX_DATA, DOUBLE_MATRIX_DATA

    def __init__(self, snapshot, analysis):
        super().__init__('openvsp')
        if analysis not in _ANALYSES or not isinstance(snapshot, dict):
            raise ValueError('Unsupported analysis or invalid snapshot')
        if (snapshot.get('protocol') != 'webvsp-p1-analysis' or
                type(snapshot.get('version')) is not int or snapshot['version'] != 1 or
                snapshot.get('model') not in ('WING', 'PROP', 'MODEL') or
                snapshot.get('analysis') != analysis):
            raise ValueError('Invalid P1 snapshot header')
        if not isinstance(snapshot.get('root'), str) or not snapshot['root']:
            raise ValueError('Invalid root result ID')
        if not isinstance(snapshot.get('results'), list):
            raise ValueError('Invalid results list')
        self.analysis = analysis
        self.model = snapshot['model']
        self.fingerprint = snapshot.get('modelFingerprint')
        self.root = snapshot['root']
        self._results = {}
        if len(snapshot['results']) > 4096:
            raise ValueError('Snapshot results budget exceeded')
        field_count = 0
        value_count = 0
        for result in snapshot['results']:
            if (not isinstance(result, dict) or not isinstance(result.get('id'), str) or
                    not result['id'] or not isinstance(result.get('name'), str) or
                    not result['name'] or not isinstance(result.get('fields'), list)):
                raise ValueError('Invalid result')
            rid = result['id']
            if rid in self._results:
                raise ValueError('Duplicate result ID: ' + rid)
            fields = {}
            field_count += len(result['fields'])
            if field_count > 100000:
                raise ValueError('Snapshot fields budget exceeded')
            for field in result['fields']:
                if (not isinstance(field, dict) or not isinstance(field.get('name'), str) or
                        not field['name'] or type(field.get('type')) is not int or
                        type(field.get('index')) is not int or field['index'] < 0 or
                        'value' not in field):
                    raise ValueError('Invalid result field')
                value_count += _validate_value(field['type'], field['value'])
                if value_count > 500000:
                    raise ValueError('Snapshot values budget exceeded')
                entries = fields.setdefault(field['name'], {})
                if field['index'] in entries:
                    raise ValueError('Duplicate result field index')
                # Freeze the validated projection against later caller mutation.
                entries[field['index']] = (field['type'], [
                    item[:] if isinstance(item, list) else item for item in field['value']
                ])
            for entries in fields.values():
                if set(entries) != set(range(len(entries))):
                    raise ValueError('Non-contiguous result field indexes')
            self._results[rid] = (result['name'], fields)
        if self.root not in self._results:
            raise ValueError('Root result missing from snapshot')
        self._check_links()

    def _check_links(self):
        # Only these fields are result-ID references; ordinary string fields are not.
        links = {'DegenGeom': {'Degen_DegenGeoms', 'surf', 'sticks', 'hinges', 'point', 'disk', 'plates'},
                 'SurfacePatches': {'components', 'surfaces', 'patches'}}[self.analysis]
        for _, fields in self._results.values():
            for name in links & fields.keys():
                for kind, values in fields[name].values():
                    if kind != STRING_DATA or any(value not in self._results for value in values):
                        raise ValueError('Invalid or missing linked result in ' + name)

    def get_instance(self, instance=None):
        if instance is not None and instance is not self:
            raise ValueError('Multiple OpenVSP instances are not supported')
        return self

    def _result(self, rid):
        if rid not in self._results:
            raise ValueError('Result ID is outside this snapshot')
        return self._results[rid]

    def GetAllDataNames(self, rid):
        return sorted(self._result(rid)[1])

    def GetResultsName(self, rid):
        return self._result(rid)[0]

    def _entries(self, rid, name):
        return self._result(rid)[1].get(name, {})

    def GetNumData(self, rid, name):
        return len(self._entries(rid, name))

    def GetResultsType(self, rid, name):
        return self._entries(rid, name).get(0, (-1, []))[0]

    def _get(self, rid, name, index, kind):
        actual, value = self._entries(rid, name).get(index, (None, []))
        # SWIG getters return a separate Python container; never hand a caller
        # a mutable alias into the validated snapshot.
        if actual != kind:
            return []
        return [item[:] if isinstance(item, list) else item for item in value]

    def GetIntResults(self, rid, name, index=0): return self._get(rid, name, index, INT_DATA)
    def GetDoubleResults(self, rid, name, index=0): return self._get(rid, name, index, DOUBLE_DATA)
    def GetStringResults(self, rid, name, index=0): return self._get(rid, name, index, STRING_DATA)
    def GetDoubleMatResults(self, rid, name, index=0): return self._get(rid, name, index, DOUBLE_MATRIX_DATA)
    def GetVec3dResults(self, rid, name, index=0): return [_Vec3d(v) for v in self._get(rid, name, index, VEC3D_DATA)]

    def SetAnalysisInputDefaults(self, analysis):
        if analysis != self.analysis:
            raise ValueError('Analysis outside snapshot')

    def SetIntAnalysisInput(self, analysis, name, values, index=0):
        if analysis != self.analysis or index != 0:
            raise ValueError('Analysis input outside snapshot')
        allowed = {'Set': [SET_ALL]}
        if analysis == 'DegenGeom':
            allowed.update(WriteCSVFlag=[0], WriteMFileFlag=[0])
        if name not in allowed or list(values) != allowed[name]:
            raise ValueError('Only SET_ALL and disabled DegenGeom file output are supported')

    def ExecAnalysis(self, analysis):
        if analysis != self.analysis:
            raise ValueError('Analysis outside snapshot')
        return self.root


def _bind(facade):
    # Each binding needs its own module globals: reassigning vsp_module on a
    # cached module invalidates earlier snapshots when a second analysis binds.
    names = ('native_openvsp_utilities', 'native_degen_geom_parse', 'native_surface_patches')
    old_vsp = sys.modules.get('openvsp')
    saved = {name: sys.modules.pop(name, None) for name in names}
    sys.modules['openvsp'] = facade
    try:
        modules = [importlib.import_module(name) for name in names]
    finally:
        if old_vsp is None:
            sys.modules.pop('openvsp', None)
        else:
            sys.modules['openvsp'] = old_vsp
        for name in names:
            sys.modules.pop(name, None)
            if saved[name] is not None:
                sys.modules[name] = saved[name]
    utility, degen, surface = modules
    facade.parse_results_object = lambda rid: utility.parse_results_object(rid, facade)
    facade.parse_degen_geom = lambda rid: degen.parse_degen_geom(rid, facade)
    return utility, degen, surface


def run():
    """Fetch and parse the analyses the host selected; return a compact JSON summary."""
    from p1_snapshot import get_snapshot
    snapshots = {}
    for analysis in _ANALYSES:
        raw = get_snapshot(analysis)
        if raw is None or raw == '':
            continue
        if not isinstance(raw, str):
            raise ValueError('Snapshot must be a JSON string')
        if len(raw) > 8 * 1024 * 1024 or len(raw.encode('utf-8')) > 8 * 1024 * 1024:
            raise ValueError('Snapshot byte budget exceeded')
        snapshots[analysis] = SnapshotFacade(json.loads(raw), analysis)
    if not snapshots:
        raise ValueError('No analysis snapshots were requested')
    if len(snapshots) == 2:
        if snapshots['DegenGeom'].model != snapshots['SurfacePatches'].model:
            raise ValueError('Snapshot models differ')
        if snapshots['DegenGeom'].fingerprint != snapshots['SurfacePatches'].fingerprint:
            raise ValueError('Copies of the current model differ between analyses')

    import numpy as np
    first = next(iter(snapshots.values()))
    summary = {'protocol': 'webvsp-p1-analysis-summary', 'version': 1,
               'model': first.model, 'modelFingerprint': first.fingerprint}

    if 'DegenGeom' in snapshots:
        degen = snapshots['DegenGeom']
        utility, parser, _ = _bind(degen)
        root = utility.parse_results_object(degen.root, degen)
        objects = parser.parse_degen_geom(degen.root, degen)
        if not objects:
            raise ValueError('DegenGeom unexpectedly produced no geometry')
        for obj in objects:
            mat = np.asarray(obj.transmat.mat)
            if mat.shape != (4, 4) or not np.isfinite(mat).all():
                raise ValueError('Invalid degen transformation')
        summary['DegenGeom'] = {
            'root': degen.root, 'rootFields': list(root._fields),
            'results': len(degen._results), 'objects': len(objects),
            'geomIds': sorted(set(o.geom_id for o in objects)),
            'details': [{'name': o.name, 'type': o.type.name, 'geomId': o.geom_id,
                         'surfaces': 1 if o.surf else 0} for o in objects]}

    if 'SurfacePatches' in snapshots:
        patch = snapshots['SurfacePatches']
        _, _, surface = _bind(patch)
        components = surface.export_surface_patches(SET_ALL, vsp_instance=patch)
        surfaces = sum(len(c.surfaces) for c in components)
        patches = sum(len(s.patches) for c in components for s in c.surfaces)
        # Check values returned by the actual helpers, not just snapshot metadata.
        if not components or not surfaces or not patches:
            raise ValueError('SurfacePatches unexpectedly produced empty geometry')
        # Exercise the unchanged helper's degenerate-filter option on the same snapshot.
        components_all = surface.export_surface_patches(SET_ALL, remove_degenerate=False, vsp_instance=patch)
        all_patches = sum(len(s.patches) for c in components_all for s in c.surfaces)
        if all_patches < patches:
            raise ValueError('Unfiltered patch count is smaller than filtered count')
        for component in components:
            for surf in component.surfaces:
                for item in surf.patches:
                    matrices = [np.asarray(getattr(item, name)) for name in ('x', 'y', 'z', 'nx', 'ny', 'nz')]
                    shape = matrices[0].shape
                    if (len(shape) != 2 or min(shape) <= 1 or
                            any(m.shape != shape or not np.isfinite(m).all() for m in matrices)):
                        raise ValueError('Invalid surface patch matrices')
        summary['SurfacePatches'] = {
            'root': patch.root, 'results': len(patch._results),
            'components': len(components), 'surfaces': surfaces, 'patches': patches,
            'details': [{'name': c.name, 'geomId': c.id, 'surfaces': len(c.surfaces),
                         'patches': sum(len(s.patches) for s in c.surfaces)} for c in components]}

    return json.dumps(summary, allow_nan=False)
