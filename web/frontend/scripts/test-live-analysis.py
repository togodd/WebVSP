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
            vsp.SetIntAnalysisInput('DegenGeom', 'Set', [True])
        self.assertEqual(self.calls, [])
        vsp.SetIntAnalysisInput('MassProp', 'NumMassSlices', [10])
        self.assertEqual(self.calls[-1], ('live_analysis_set_int', {'analysis': 'MassProp', 'name': 'NumMassSlices', 'index': 0, 'values': [10]}))

    def test_vspaero_files_forwarding(self):
        self.reply['value'] = [{'path': '/work/case.vspgeom', 'exists': True, 'size': 10}]
        self.assertEqual(vsp.GetVSPAEROFiles(), [{'path': '/work/case.vspgeom', 'exists': True, 'size': 10}])
        self.assertEqual(self.calls[-1], ('live_vspaero_files', {}))

    def test_vspaero_control_forwarding(self):
        self.reply['value'] = 'Done with setup...\n'
        self.assertEqual(vsp.GetVSPAEROOutput(), 'Done with setup...\n')
        self.assertEqual(self.calls[-1], ('live_vspaero_output', {}))
        vsp.KillVSPAERO()
        self.assertEqual(self.calls[-1], ('live_vspaero_kill', {}))

    def test_vspaero_reference_and_control_groups(self):
        self.reply['value'] = 'wg-1'
        self.assertEqual(vsp.GetVSPAERORefWingID(), 'wg-1')
        self.assertEqual(self.calls[-1], ('live_vspaero_ref_wing', {}))
        vsp.SetVSPAERORefWingID('wg-2')
        self.assertEqual(self.calls[-1], ('live_vspaero_set_ref_wing', {'geom_id': 'wg-2'}))
        self.reply['value'] = 'mode-1'
        self.assertEqual(vsp.GetVSPAEROModeID(), 'mode-1')
        self.assertEqual(self.calls[-1], ('live_vspaero_mode', {}))
        vsp.SetVSPAEROModeID('mode-2')
        self.assertEqual(self.calls[-1], ('live_vspaero_set_mode', {'mode_id': 'mode-2'}))
        vsp.GetVSPAEROCGModeID()
        self.assertEqual(self.calls[-1][0], 'live_vspaero_cg_mode')
        vsp.SetVSPAEROCGModeID('mode-3')
        self.assertEqual(self.calls[-1][0], 'live_vspaero_set_cg_mode')
        self.reply['value'] = '/bin'
        self.assertEqual(vsp.GetVSPAEROPath(), '/bin')
        self.assertEqual(self.calls[-1], ('live_vspaero_path', {}))
        self.reply['value'] = 'csg-1'
        self.assertEqual(vsp.AddVSPAEROControlSurfaceGroup(), 'csg-1')
        self.assertEqual(self.calls[-1], ('live_vspaero_add_cs_group', {}))
        vsp.AutoGroupVSPAEROControlSurfaces()
        self.assertEqual(self.calls[-1], ('live_vspaero_auto_group', {}))
        for fn, op in ((vsp.DeleteVSPAEROControlSurfaceGroup, 'live_vspaero_delete_cs_group'),
                       (vsp.AddAllToVSPAEROControlSurfaceGroup, 'live_vspaero_add_all_cs_group'),
                       (vsp.RemoveAllFromVSPAEROControlSurfaceGroup, 'live_vspaero_remove_all_cs_group')):
            fn(2)
            self.assertEqual(self.calls[-1], (op, {'index': 2}))
        self.reply['value'] = 'Aileron'
        self.assertEqual(vsp.GetVSPAEROControlGroupName(1), 'Aileron')
        self.assertEqual(self.calls[-1], ('live_vspaero_get_cs_name', {'index': 1}))
        vsp.SetVSPAEROControlGroupName('Flap', 1)
        self.assertEqual(self.calls[-1], ('live_vspaero_set_cs_name', {'name': 'Flap', 'index': 1}))
        with self.assertRaisesRegex(ValueError, 'index'):
            vsp.DeleteVSPAEROControlSurfaceGroup(-1)
        with self.assertRaisesRegex(ValueError, 'name'):
            vsp.SetVSPAEROControlGroupName('', 0)

    def test_typed_inputs(self):
        for kind in ('Int', 'Double', 'String'):
            getattr(vsp, 'Get' + kind + 'AnalysisInput')('AnyAnalysis', 'Input', 2)
            self.assertEqual(self.calls[-1], ('live_analysis_get_' + kind.lower(), {'analysis': 'AnyAnalysis', 'name': 'Input', 'index': 2}))
            with self.assertRaises(ValueError):
                getattr(vsp, 'Get' + kind + 'AnalysisInput')('A', 'B', -1)
        vsp.SetDoubleAnalysisInput('A', 'B', [1.25])
        self.assertEqual(self.calls[-1], ('live_analysis_set_double', {'analysis': 'A', 'name': 'B', 'index': 0, 'values': [1.25]}))
        # Full vectors and non-zero indices now go in one call.
        vsp.SetDoubleAnalysisInput('A', 'B', [1.5, -2.25], 3)
        self.assertEqual(self.calls[-1], ('live_analysis_set_double', {'analysis': 'A', 'name': 'B', 'index': 3, 'values': [1.5, -2.25]}))
        vsp.SetDoubleAnalysisInput('A', 'B', [])
        self.assertEqual(self.calls[-1][1]['values'], [])
        for value in ('', '你好\n😀', 'a;b:c'):
            vsp.SetStringAnalysisInput('A', 'B', [value, value])
            self.assertEqual(self.calls[-1][1]['values'], [value, value])
        for fn, value in ((vsp.SetDoubleAnalysisInput, True), (vsp.SetStringAnalysisInput, 'a\0b'), (vsp.SetIntAnalysisInput, 2147483648)):
            with self.assertRaises(ValueError):
                fn('A', 'B', [value])
        with self.assertRaises(ValueError):
            vsp.SetDoubleAnalysisInput('A', 'B', [1.0], -1)


if __name__ == '__main__':
    unittest.main()
