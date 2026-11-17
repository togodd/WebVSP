"""Host tests for geometry hierarchy and rename forwarding."""
import json
import re
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

    def test_native_xsec_and_subsurface_enums(self):
        header = (Path(__file__).resolve().parents[3] / 'src/geom_api/APIDefines.h').read_text()
        for enum in ('XSEC_CRV_TYPE', 'SUBSURF_TYPE'):
            body = re.search(r'\benum\s+' + enum + r'\s*\{(.*?)\}', header, re.S).group(1)
            body = re.sub(r'/\*.*?\*/|//[^\n]*', '', body, flags=re.S)
            value = -1
            for item in body.split(','):
                item = item.strip()
                if not item:
                    continue
                parts = item.split('=', 1)
                name = parts[0].strip()
                value = int(parts[1].strip(), 0) if len(parts) == 2 else value + 1
                self.assertEqual(getattr(vsp, name), value, name)

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

    def test_section_and_subsurface_indices(self):
        self.reply['value'] = ['first', 'last']
        for get in (vsp.GetXSecSurf, vsp.GetXSec, vsp.GetSubSurf):
            self.assertEqual(get('id', 0), 'first')
            self.assertEqual(get('id', 1), 'last')
            for index in (-1, -2, 2):
                with self.assertRaises(IndexError):
                    get('id', index)
            with self.assertRaises(TypeError):
                get('id', 0.5)
        with self.assertRaises(IndexError):
            vsp.ChangeXSecShape('id', -1, 1)
        self.assertNotEqual(self.calls[-1][0], 'live_change_xsec_shape')

    def test_xsec_by_id_forwarding(self):
        self.reply['value'] = ['s1', 's2']
        self.assertEqual(vsp.GetXSecIDVec('surf'), ['s1', 's2'])
        self.assertEqual(self.calls[-1], ('live_xsec_ids', {'xsec_surf_id': 'surf'}))
        self.reply['value'] = 'new'
        self.assertEqual(vsp.InsertXSecByID('s1', vsp.XS_ELLIPSE), 'new')
        self.assertEqual(self.calls[-1], ('live_insert_xsec_by_id', {'xsec_id': 's1', 'shape': vsp.XS_ELLIPSE}))
        vsp.CutXSecByID('new')
        self.assertEqual(self.calls[-1], ('live_delete_xsec_by_id', {'xsec_id': 'new'}))

    def test_xsec_clipboard_forwarding(self):
        for func, args, op, payload in (
            (vsp.CopyXSec, ('g', 2), 'live_copy_xsec', {'geom_id': 'g', 'index': 2}),
            (vsp.CopyXSecByID, ('x',), 'live_copy_xsec_by_id', {'xsec_id': 'x'}),
            (vsp.PasteXSec, ('g', 3), 'live_paste_xsec', {'geom_id': 'g', 'index': 3}),
            (vsp.PasteXSecByID, ('x',), 'live_paste_xsec_by_id', {'xsec_id': 'x'}),
        ):
            self.assertIsNone(func(*args))
            self.assertEqual(self.calls[-1], (op, payload))

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
