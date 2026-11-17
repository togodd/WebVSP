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

    def test_surface_queries(self):
        u, w = 0.12345678901234566, 0.9876543210987654
        self.reply['value'] = [u, w, -u]
        for func, op in ((vsp.CompPnt01, 'live_comp_pnt01'), (vsp.CompNorm01, 'live_comp_norm01')):
            result = func(geom_id='g', surf_indx=2, u=u, w=w)
            self.assertEqual((result.x(), result.y(), result.z()), (u, w, -u))
            self.assertEqual(self.calls[-1], (op, {'geom_id': 'g', 'surf_indx': 2, 'u': u, 'w': w}))
        self.reply = {'ok': False, 'error': {'message': 'invalid surface'}}
        with self.assertRaisesRegex(vsp.OpenVSPError, 'invalid surface'):
            vsp.CompPnt01('g', -1, u, w)
        with self.assertRaises(vsp.OpenVSPError):
            vsp.CompNorm01('g', 0, float('nan'), w)

    def test_geometry_display_forwarding(self):
        self.reply['value'] = 1
        self.assertEqual(vsp.GetGeomDrawType('g'), 1)
        self.assertEqual(self.calls[-1], ('live_geom_draw_type', {'geom_id': 'g'}))
        self.assertEqual(vsp.GetGeomDisplayType('g'), 1)
        self.assertEqual(self.calls[-1], ('live_geom_display_type', {'geom_id': 'g'}))
        vsp.SetGeomDrawType('g', 2)
        self.assertEqual(self.calls[-1], ('live_geom_set_draw_type', {'geom_id': 'g', 'type': 2}))
        vsp.SetGeomDisplayType('g', 3)
        self.assertEqual(self.calls[-1], ('live_geom_set_display_type', {'geom_id': 'g', 'type': 3}))
        self.reply['value'] = [10.0, 20.0, 30.0]
        self.assertEqual(vsp.GetGeomWireColor('g'), [10.0, 20.0, 30.0])
        self.assertEqual(self.calls[-1], ('live_geom_wire_color', {'geom_id': 'g'}))
        vsp.SetGeomWireColor('g', (1, 2, 3))
        self.assertEqual(self.calls[-1], ('live_geom_set_wire_color', {'geom_id': 'g', 'rgb': [1, 2, 3]}))
        self.reply['value'] = 'Default'
        self.assertEqual(vsp.GetGeomMaterialName('g'), 'Default')
        self.assertEqual(self.calls[-1], ('live_geom_material', {'geom_id': 'g'}))
        vsp.SetGeomMaterialName('g', 'Aluminum')
        self.assertEqual(self.calls[-1], ('live_geom_set_material', {'geom_id': 'g', 'name': 'Aluminum'}))
        self.reply['value'] = [-1.0, -2.0, -3.0]
        self.assertEqual(vsp.GetGeomBBoxMin('g'), [-1.0, -2.0, -3.0])
        self.assertEqual(self.calls[-1], ('live_geom_bbox_min', {'geom_id': 'g', 'surf': 0, 'absolute': True}))
        vsp.GetGeomBBoxMax('g', 1, False)
        self.assertEqual(self.calls[-1], ('live_geom_bbox_max', {'geom_id': 'g', 'surf': 1, 'absolute': False}))
        with self.assertRaisesRegex(ValueError, 'draw type'):
            vsp.SetGeomDrawType('g', 'shade')
        with self.assertRaisesRegex(ValueError, 'Wire colour'):
            vsp.SetGeomWireColor('g', (0, 0, 256))
        with self.assertRaisesRegex(ValueError, 'Wire colour'):
            vsp.SetGeomWireColor('g', (0, 0))
        with self.assertRaisesRegex(ValueError, 'material name'):
            vsp.SetGeomMaterialName('g', None)

    def test_xsec_curve_forwarding(self):
        self.reply['value'] = 'alias'
        self.assertEqual(vsp.GetXSecAlias('x'), 'alias')
        self.assertEqual(self.calls[-1], ('live_xsec_alias', {'xsec_id': 'x'}))
        self.assertEqual(vsp.GetXSecCurveAlias('x'), 'alias')
        self.assertEqual(self.calls[-1], ('live_xsec_curve_alias', {'xsec_id': 'x'}))
        vsp.SetXSecAlias('x', 'a1')
        self.assertEqual(self.calls[-1], ('live_xsec_set_alias', {'xsec_id': 'x', 'alias': 'a1'}))
        vsp.SetXSecCurveAlias('x', 'c1')
        self.assertEqual(self.calls[-1], ('live_xsec_set_curve_alias', {'xsec_id': 'x', 'alias': 'c1'}))
        self.reply['value'] = 2
        self.assertEqual(vsp.GetXSecContinuity('x'), 2)
        self.assertEqual(self.calls[-1], ('live_xsec_continuity', {'xsec_id': 'x'}))
        vsp.SetXSecContinuity('x', 1)
        self.assertEqual(self.calls[-1], ('live_xsec_set_continuity', {'xsec_id': 'x', 'continuity': 1}))
        self.reply['value'] = [0.0, 1.0, 2.0, 3.0]
        self.assertEqual(vsp.GetXSecTanAngles('x', 0), [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(self.calls[-1], ('live_xsec_tan_angles', {'xsec_id': 'x', 'side': 0}))
        vsp.SetXSecTanSlews('x', 1, 0.5, 0.6, 0.7, 0.8)
        self.assertEqual(self.calls[-1], ('live_xsec_set_tan_slews', {'xsec_id': 'x', 'side': 1, 'fields': [0.5, 0.6, 0.7, 0.8]}))
        with self.assertRaisesRegex(ValueError, 'continuity'):
            vsp.SetXSecContinuity('x', 1.5)
        with self.assertRaisesRegex(ValueError, 'side'):
            vsp.GetXSecTanStrengths('x', '0')
        with self.assertRaisesRegex(ValueError, 'finite'):
            vsp.SetXSecCurvatures('x', 0, 1.0, 2.0, 3.0, float('nan'))

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

    def test_xsec_dimensions_and_native_parm_forwarding(self):
        for func, args, op, payload in (
            (vsp.GetXSecSurfIDVec, ('g',), 'live_xsec_surf_ids', {'geom_id': 'g'}),
            (vsp.GetXSecWidth, ('x',), 'live_xsec_width', {'xsec_id': 'x'}),
            (vsp.GetXSecHeight, ('x',), 'live_xsec_height', {'xsec_id': 'x'}),
            (vsp.GetXSecParm, ('x', 'Width'), 'live_xsec_parm', {'xsec_id': 'x', 'name': 'Width'}),
            (vsp.SetXSecWidth, ('x', 2), 'live_xsec_set_width', {'xsec_id': 'x', 'width': 2.0}),
            (vsp.SetXSecHeight, ('x', 3), 'live_xsec_set_height', {'xsec_id': 'x', 'height': 3.0}),
            (vsp.SetXSecWidthHeight, ('x', 2, 3), 'live_xsec_set_width_height', {'xsec_id': 'x', 'width': 2.0, 'height': 3.0}),
            (vsp.SetParmVal, ('p', 2), 'live_parm_set_by_id', {'parm_id': 'p', 'value': 2.0}),
            (vsp.SetParmVal, ('g', 'n', 'grp', 3), 'live_parm_set', {'geom_id': 'g', 'key': 'grp\x1fn', 'value': 3.0}),
        ):
            func(*args)
            self.assertEqual(self.calls[-1], (op, payload))
        with self.assertRaises(TypeError):
            vsp.SetParmVal('p')
        for func, args in ((vsp.SetXSecWidth, ('x', float('nan'))), (vsp.SetXSecWidthHeight, ('x', 1, float('inf')))):
            with self.assertRaises(vsp.OpenVSPError) as ctx:
                func(*args)
            self.assertEqual(ctx.exception.outcome, 'not_written')

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
