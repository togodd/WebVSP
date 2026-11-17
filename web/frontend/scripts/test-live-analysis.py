"""Host tests for analysis discovery and set lookup forwarding."""
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *args: None)
import openvsp_live as vsp  # noqa: E402


class AnalysisApiTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.reply = {'ok': True, 'value': None}
        def request(op, raw):
            self.calls.append((op, json.loads(raw)))
            return json.dumps(self.reply)
        vsp.request = request

    def test_discovery(self):
        vsp.ListAnalysis()
        self.assertEqual(self.calls[-1][0], 'live_list_analysis')
        vsp.GetAnalysisInputNames('MassProp')
        self.assertEqual(self.calls[-1], ('live_analysis_input_names', {'analysis': 'MassProp'}))
        vsp.GetAnalysisInputType('MassProp', 'Set')
        self.assertEqual(self.calls[-1], ('live_analysis_input_type', {'analysis': 'MassProp', 'name': 'Set'}))

    def test_sets(self):
        vsp.GetSetIndex('All')
        self.assertEqual(self.calls[-1], ('live_set_index', {'name': 'All'}))
        vsp.GetGeomSet('All')
        self.assertEqual(self.calls[-1], ('live_geom_set', {'name': 'All'}))
        vsp.GetGeomSetAtIndex(0)
        self.assertEqual(self.calls[-1], ('live_geom_set_at_index', {'index': 0}))
        with self.assertRaisesRegex(ValueError, 'index'):
            vsp.GetGeomSetAtIndex(-1)
        with self.assertRaisesRegex(ValueError, 'name'):
            vsp.GetGeomSet('')

    def test_analysis_input_validation(self):
        with self.assertRaises(ValueError):
            vsp.SetIntAnalysisInput('DegenGeom', 'Set', [1, 2])
        with self.assertRaises(ValueError):
            vsp.SetIntAnalysisInput('DegenGeom', 'Set', [True])
        self.assertEqual(self.calls, [])
        vsp.SetIntAnalysisInput('MassProp', 'NumMassSlices', [10])
        self.assertEqual(self.calls[-1], ('live_analysis_set_int', {'analysis': 'MassProp', 'name': 'NumMassSlices', 'value': 10}))

    def test_typed_inputs(self):
        for kind in ('Int', 'Double', 'String'):
            getattr(vsp, 'Get' + kind + 'AnalysisInput')('AnyAnalysis', 'Input', 2)
            self.assertEqual(self.calls[-1], ('live_analysis_get_' + kind.lower(), {'analysis': 'AnyAnalysis', 'name': 'Input', 'index': 2}))
            with self.assertRaises(ValueError):
                getattr(vsp, 'Get' + kind + 'AnalysisInput')('A', 'B', -1)
        vsp.SetDoubleAnalysisInput('A', 'B', [1.25])
        self.assertEqual(self.calls[-1], ('live_analysis_set_double', {'analysis': 'A', 'name': 'B', 'value': 1.25}))
        for value in ('', '你好\n😀'):
            vsp.SetStringAnalysisInput('A', 'B', [value])
            self.assertEqual(self.calls[-1][1]['value'], value)
        for fn, value in ((vsp.SetDoubleAnalysisInput, True), (vsp.SetStringAnalysisInput, 'a\0b'), (vsp.SetIntAnalysisInput, 2147483648)):
            with self.assertRaises(ValueError):
                fn('A', 'B', [value])
        with self.assertRaises(ValueError):
            vsp.SetDoubleAnalysisInput('A', 'B', [1.0], 1)


if __name__ == '__main__':
    unittest.main()
