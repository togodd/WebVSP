"""Host tests for live write bridge error and timeout semantics."""
import json
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *_: None)
import openvsp_live as vsp


class LiveErrorsTest(unittest.TestCase):
    def test_delete_clone_policy_is_forwarded(self):
        calls = []
        def request(op, payload):
            calls.append((op, json.loads(payload)))
            return json.dumps({'ok': True, 'value': None})
        vsp.request = request
        vsp.DeleteGeom('g')
        for policy in (vsp.CLONE_DELETE_LEAVE_EMPTY, vsp.CLONE_DELETE_WITH_ORIGINAL, vsp.CLONE_DELETE_REPLACE, 99):
            vsp.DeleteGeom('g', policy)
        self.assertEqual([args['clone_delete'] for _, args in calls], [0, 0, 1, 2, 99])
        self.assertTrue(all(op == 'live_delete_geom' for op, _ in calls))

    def test_geometry_facade_forwards_arguments_and_write_outcomes(self):
        calls = []
        def request(op, payload):
            calls.append((op, json.loads(payload)))
            return json.dumps({'ok': True, 'value': ['POD'] if op == 'live_geom_types' else
                               1 if op == 'live_num_main_surfs' else
                               ['new'] if op == 'live_paste_geom' else None})
        vsp.request = request
        self.assertEqual(vsp.GetGeomTypes(), ['POD'])
        self.assertEqual(vsp.GetNumMainSurfs('g'), 1)
        self.assertIsNone(vsp.UpdateGeom('g'))
        self.assertIsNone(vsp.SetGeomParent('g', ''))
        self.assertIsNone(vsp.CopyGeomToClipboard('g'))
        self.assertIsNone(vsp.CutGeomToClipboard('g'))
        self.assertIsNone(vsp.CutGeomToClipboard('g', 2))
        self.assertEqual(vsp.PasteGeomClipboard(), ['new'])
        self.assertEqual(vsp.PasteGeomClipboard('p'), ['new'])
        self.assertEqual(calls, [
            ('live_geom_types', {}), ('live_num_main_surfs', {'geom_id': 'g'}),
            ('live_update_geom', {'geom_id': 'g'}), ('live_set_geom_parent', {'geom_id': 'g', 'parent_id': ''}),
            ('live_copy_geom', {'geom_id': 'g'}), ('live_cut_geom', {'geom_id': 'g', 'clone_delete': 0}),
            ('live_cut_geom', {'geom_id': 'g', 'clone_delete': 2}),
            ('live_paste_geom', {'parent': ''}), ('live_paste_geom', {'parent': 'p'}),
        ])
        vsp.request = lambda *_: (_ for _ in ()).throw(RuntimeError('transport'))
        for operation in (lambda: vsp.UpdateGeom('g'), lambda: vsp.SetGeomParent('g', ''),
                          lambda: vsp.CopyGeomToClipboard('g'), lambda: vsp.CutGeomToClipboard('g'),
                          lambda: vsp.PasteGeomClipboard()):
            with self.assertRaises(vsp.OpenVSPError) as caught:
                operation()
            self.assertEqual(caught.exception.outcome, 'unknown')
        with self.assertRaises(vsp.OpenVSPError) as caught:
            vsp.GetNumMainSurfs('g')
        self.assertIsNone(caught.exception.outcome)

    def test_propagates_engine_error_metadata(self):
        vsp.request = lambda *_: json.dumps({'ok': False, 'error': {'message': 'rejected', 'outcome': 'not_written', 'actual': 2, 'code': 'GUARD'}})
        with self.assertRaises(vsp.OpenVSPError) as caught:
            vsp.AddGeom('WING')
        self.assertEqual((caught.exception.outcome, caught.exception.actual, caught.exception.code), ('not_written', 2, 'GUARD'))

    def test_timeout_is_unknown_and_not_retried(self):
        calls = []
        def timeout(*args):
            calls.append(args)
            raise RuntimeError('timed out; do not retry')
        vsp.request = timeout
        with self.assertRaises(vsp.OpenVSPError) as caught:
            vsp.AddGeom('WING')
        self.assertEqual((caught.exception.outcome, caught.exception.code), ('unknown', 'TRANSPORT'))
        self.assertEqual(len(calls), 1)

    def test_malformed_write_response_is_unknown(self):
        for value in ('{}', '{', '{"ok":true}', '{"ok":false,"error":[]}'):
            vsp.request = lambda *_, value=value: value
            with self.assertRaises(vsp.OpenVSPError) as caught:
                vsp.Update()
            self.assertEqual(caught.exception.outcome, 'unknown')

    def test_invalid_arguments_are_not_written(self):
        vsp.request = lambda *_: self.fail('must not dispatch')
        with self.assertRaises(vsp.OpenVSPError) as caught:
            vsp.SetParmVal('g', 'n', 'p', float('nan'))
        self.assertEqual(caught.exception.outcome, 'not_written')


if __name__ == '__main__':
    unittest.main()
