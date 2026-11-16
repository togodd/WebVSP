"""Host tests for the Python file API's path rules and argument validation."""
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *args: None)
import openvsp_live as vsp  # noqa: E402


class FileApiTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.values = {}
        def request(op, raw):
            self.calls.append((op, json.loads(raw)))
            return json.dumps({'ok': True, 'value': self.values.get(op)})
        vsp.request = request

    def test_relative_paths_resolve_in_workspace(self):
        vsp.ReadVSPFile('models/a.vsp3')
        self.assertEqual(self.calls[-1], ('read_file', {'path': '/work/models/a.vsp3'}))
        vsp.WriteVSPFile('out.vsp3')
        self.assertEqual(self.calls[-1], ('write_file', {'path': '/work/out.vsp3'}))
        vsp.SetVSP3FileName('renamed.vsp3')
        self.assertEqual(self.calls[-1], ('set_vsp_file_name', {'path': '/work/renamed.vsp3'}))

    def test_absolute_paths_pass_through(self):
        vsp.ReadVSPFile('/tmp/m.vsp3')
        self.assertEqual(self.calls[-1][1]['path'], '/tmp/m.vsp3')

    def test_workspace_escape_is_rejected(self):
        for bad in ('../x.vsp3', 'a/../../x.vsp3'):
            with self.assertRaisesRegex(ValueError, 'escapes'):
                vsp.ReadVSPFile(bad)
        self.assertEqual(self.calls, [])

    def test_write_set_and_export_options(self):
        with self.assertRaisesRegex(ValueError, 'SET_ALL'):
            vsp.WriteVSPFile('x.vsp3', set=1)
        vsp.ExportFile('x.stl', vsp.SET_ALL, vsp.EXPORT_STL)
        self.assertEqual(self.calls[-1], ('export_file', {'path': '/work/x.stl', 'file_type': 2, 'set': 0}))
        with self.assertRaisesRegex(ValueError, 'default ExportFile'):
            vsp.ExportFile('x.stl', vsp.SET_ALL, vsp.EXPORT_STL, subs_flag=0)

    def test_import_and_clear(self):
        vsp.ImportFile('x.stl', vsp.IMPORT_STL)
        self.assertEqual(self.calls[-1], ('import_file', {'path': '/work/x.stl', 'file_type': 0}))
        with self.assertRaisesRegex(ValueError, 'parent'):
            vsp.ImportFile('x.stl', vsp.IMPORT_STL, parent='g')
        vsp.ClearVSPModel()
        self.assertEqual(self.calls[-1][0], 'clear_model')

    def test_constants_match_native_order(self):
        self.assertEqual((vsp.EXPORT_STL, vsp.EXPORT_STEP, vsp.EXPORT_OBJ), (2, 12, 20))
        self.assertEqual((vsp.IMPORT_STL, vsp.IMPORT_PTS, vsp.IMPORT_P3D_WIRE), (0, 4, 8))
        self.assertEqual(vsp.SET_NONE, -1)


if __name__ == '__main__':
    unittest.main()
