"""Host tests for the isolated analysis snapshot adapter (no WASM required)."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
from p1_analysis import SnapshotFacade, _bind, run
import types
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python/native'))


def sample():
    return {'protocol': 'webvsp-p1-analysis', 'version': 1, 'model': 'WING',
            'analysis': 'DegenGeom', 'root': 'root', 'results': [
                {'id': 'root', 'name': 'DegenGeom', 'fields': [
                    {'name': 'Degen_DegenGeoms', 'type': 3, 'index': 0, 'value': ['child']}]},
                {'id': 'child', 'name': 'Degen', 'fields': [
                    {'name': 'vec', 'type': 4, 'index': 0, 'value': [[1, 2, 3]]},
                    {'name': 'matrix', 'type': 6, 'index': 0, 'value': [[1, 2], [3, 4]]},
                    {'name': 'nums', 'type': 1, 'index': 0, 'value': [42]}]}]}


class P1SnapshotTest(unittest.TestCase):
    def test_values_and_restrictions(self):
        f = SnapshotFacade(sample(), 'DegenGeom')
        self.assertEqual(f.GetStringResults('root', 'Degen_DegenGeoms'), ['child'])
        matrix = f.GetDoubleMatResults('child', 'matrix')
        self.assertEqual(matrix, [[1, 2], [3, 4]])
        matrix[0][0] = 99
        self.assertEqual(f.GetDoubleMatResults('child', 'matrix'), [[1, 2], [3, 4]])
        links = f.GetStringResults('root', 'Degen_DegenGeoms')
        links.append('not-owned')
        self.assertEqual(f.GetStringResults('root', 'Degen_DegenGeoms'), ['child'])
        v = f.GetVec3dResults('child', 'vec')[0]
        self.assertEqual((v.x(), v.y(), v.z()), (1, 2, 3))
        self.assertEqual(f.GetNumData('child', 'absent'), 0)
        with self.assertRaises(ValueError): f.ExecAnalysis('Other')
        with self.assertRaises(ValueError): f.SetIntAnalysisInput('DegenGeom', 'WriteCSVFlag', [1])
        with self.assertRaises(ValueError): f.SetIntAnalysisInput('DegenGeom', 'Set', [1])
        with self.assertRaises(ValueError): f.GetResultsName('not-owned')

    def test_constructor_copies_source_values(self):
        data = sample()
        facade = SnapshotFacade(data, 'DegenGeom')
        data['results'][0]['fields'][0]['value'].append('bad')
        data['results'][1]['fields'][0]['value'][0][0] = 9
        data['results'][1]['fields'][1]['value'][0][0] = 9
        self.assertEqual(facade.GetStringResults('root', 'Degen_DegenGeoms'), ['child'])
        self.assertEqual(facade.GetVec3dResults('child', 'vec')[0].x(), 1)
        self.assertEqual(facade.GetDoubleMatResults('child', 'matrix')[0][0], 1)

    def test_bindings_remain_independent(self):
        first = SnapshotFacade(sample(), 'DegenGeom')
        other = sample()
        other['results'][1]['fields'][2]['value'] = [17]
        second = SnapshotFacade(other, 'DegenGeom')
        native = Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python/native'
        paths = {'native_openvsp_utilities': native / 'openvsp_utilities.py',
                 'native_degen_geom_parse': native / 'degen_geom_parse.py',
                 'native_surface_patches': native / 'surface_patches.py'}
        original_import = __import__('importlib').import_module
        def load(name):
            if name not in paths:
                return original_import(name)
            spec = importlib.util.spec_from_file_location(name, paths[name])
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
            return module
        with patch('p1_analysis.importlib.import_module', side_effect=load):
            first_utility, _, _ = _bind(first)
            _bind(second)
        self.assertEqual(first_utility.parse_results_object(first.root, first).Degen_DegenGeoms, ['child'])
        self.assertEqual(first.parse_results_object(first.root).Degen_DegenGeoms, ['child'])
        self.assertEqual(second.parse_results_object(second.root).Degen_DegenGeoms, ['child'])
        self.assertEqual(first.parse_results_object('child').nums, [42])
        self.assertEqual(second.parse_results_object('child').nums, [17])
        self.assertEqual(first.parse_results_object('child').nums, [42])

    def test_rejects_oversized_json_before_parsing(self):
        oversized = types.ModuleType('p1_snapshot')
        oversized.get_snapshot = lambda _: 'é' * (4 * 1024 * 1024 + 1)
        with patch.dict(sys.modules, {'p1_snapshot': oversized}):
            with self.assertRaisesRegex(ValueError, 'byte budget'):
                run()

    def test_integer_matrix_is_valid_but_original_helper_ignores_it(self):
        s = sample()
        s['results'][1]['fields'].append({'name': 'imat', 'type': 5, 'index': 0, 'value': [[1, -2], []]})
        f = SnapshotFacade(s, 'DegenGeom')
        self.assertEqual(f.GetResultsType('child', 'imat'), f.INT_MATRIX_DATA)
        s['results'][1]['fields'][-1]['value'] = [[1, 2.5]]
        with self.assertRaisesRegex(ValueError, 'invalid result value'):
            SnapshotFacade(s, 'DegenGeom')

    def test_field_budget(self):
        s = sample()
        s['results'][0]['fields'] = [
            {'name': 'entry', 'type': 1, 'index': i, 'value': []} for i in range(100001)
        ]
        with self.assertRaisesRegex(ValueError, 'fields budget'):
            SnapshotFacade(s, 'DegenGeom')

    def test_value_budget_counts_nested_values(self):
        s = sample()
        s['results'][1]['fields'][1]['value'] = [[0] * 250000, [0] * 250000]
        with self.assertRaisesRegex(ValueError, 'values budget'):
            SnapshotFacade(s, 'DegenGeom')

    def test_invalid_snapshots(self):
        cases = []
        s = sample(); s['root'] = 'missing'; cases.append(s)
        s = sample(); s['results'][0]['fields'][0]['value'] = ['missing']; cases.append(s)
        s = sample(); s['results'][1]['fields'][0]['value'] = [[1, float('nan'), 3]]; cases.append(s)
        s = sample(); s['results'][1]['fields'][0]['index'] = 1; cases.append(s)
        s = sample(); s['results'][1]['fields'][0]['type'] = 99; cases.append(s)
        s = sample(); s['results'].append(copy.deepcopy(s['results'][0])); cases.append(s)
        s = sample(); s['results'] = s['results'] * 2049; cases.append(s)
        for data in cases:
            with self.subTest(data=data), self.assertRaises(ValueError): SnapshotFacade(data, 'DegenGeom')


if __name__ == '__main__': unittest.main()
