"""Host tests for geometry hierarchy and rename forwarding."""
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *args: None)
import openvsp_live as vsp  # noqa: E402


class GeometryApiTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.reply = {'ok': True, 'value': None}
        def request(op, raw):
            self.calls.append((op, json.loads(raw)))
            return json.dumps(self.reply)
        vsp.request = request

    def test_queries(self):
        vsp.FindGeoms()
        self.assertEqual(self.calls[-1][0], 'find_geoms')
        vsp.FindGeom('Wing', 2)
        self.assertEqual(self.calls[-1], ('find_geom', {'name': 'Wing', 'index': 2}))
        vsp.GetGeomName('g')
        self.assertEqual(self.calls[-1], ('geom_name', {'geom_id': 'g'}))
        vsp.GetGeomTypeName('g')
        self.assertEqual(self.calls[-1], ('geom_type', {'geom_id': 'g'}))
        vsp.GetGeomParent('g')
        self.assertEqual(self.calls[-1], ('geom_parent', {'geom_id': 'g'}))
        vsp.GetGeomChildren('g')
        self.assertEqual(self.calls[-1], ('geom_children', {'geom_id': 'g'}))

    def test_rename(self):
        self.assertIsNone(vsp.SetGeomName('g', 'MainWing'))
        self.assertEqual(self.calls[-1], ('live_set_geom_name', {'geom_id': 'g', 'name': 'MainWing'}))
        with self.assertRaisesRegex(ValueError, 'geometry ID'):
            vsp.SetGeomName('', 'x')
        with self.assertRaisesRegex(ValueError, 'geometry name'):
            vsp.SetGeomName('g', '')
        with self.assertRaisesRegex(ValueError, '256'):
            vsp.SetGeomName('g', 'é' * 129)
        self.assertEqual(len(self.calls), 1)

    def test_query_validation(self):
        with self.assertRaisesRegex(ValueError, 'geometry name'):
            vsp.FindGeom('')
        with self.assertRaisesRegex(ValueError, 'index'):
            vsp.FindGeom('Wing', -1)
        with self.assertRaisesRegex(ValueError, 'index'):
            vsp.FindGeom('Wing', True)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
