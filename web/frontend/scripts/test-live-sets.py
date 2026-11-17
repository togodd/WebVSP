"""Host-only tests for the live Set API facade and bridge forwarding."""
import json
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *_: None)
import openvsp_live as vsp  # noqa: E402


class SetApiTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.values = {}
        self.original_request = vsp.request
        vsp.request = self.request
        self.addCleanup(setattr, vsp, 'request', self.original_request)

    def request(self, op, raw):
        args = json.loads(raw)
        self.calls.append((op, args))
        value = self.values[op]
        if callable(value):
            value = value(args)
        return json.dumps({'ok': True, 'value': value})

    def test_get_set_names_enumerates_in_order(self):
        names = ['All', 'Shown', '自定义']
        self.values = {'live_num_sets': len(names), 'live_set_name': lambda args: names[args['index']]}
        self.assertEqual(vsp.GetSetNames(), names)
        self.assertEqual(self.calls, [('live_num_sets', {}), *[
            ('live_set_name', {'index': i}) for i in range(len(names))
        ]])
        self.calls.clear()
        self.values['live_num_sets'] = 0
        self.assertEqual(vsp.GetSetNames(), [])
        self.assertEqual(self.calls, [('live_num_sets', {})])

    def test_get_set_name_and_index(self):
        self.values = {'live_set_name': '机翼', 'live_set_index': -1}
        self.assertEqual(vsp.GetSetName(7), '机翼')
        self.assertEqual(vsp.GetSetIndex('missing'), -1)
        self.values['live_set_index'] = 7
        self.assertEqual(vsp.GetSetIndex('机翼'), 7)
        self.assertEqual(self.calls, [
            ('live_set_name', {'index': 7}),
            ('live_set_index', {'name': 'missing'}),
            ('live_set_index', {'name': '机翼'}),
        ])

    def test_geometry_set_queries(self):
        self.values = {'live_geom_set': ['g1', 'g2'], 'live_geom_set_at_index': []}
        self.assertEqual(vsp.GetGeomSet('机翼'), ['g1', 'g2'])
        self.assertEqual(vsp.GetGeomSetAtIndex(7), [])
        self.values['live_geom_set_at_index'] = ['g2']
        self.assertEqual(vsp.GetGeomSetAtIndex(0), ['g2'])
        self.assertEqual(self.calls, [
            ('live_geom_set', {'name': '机翼'}),
            ('live_geom_set_at_index', {'index': 7}),
            ('live_geom_set_at_index', {'index': 0}),
        ])

    def test_get_flag_and_setters(self):
        self.values = {'live_get_set_flag': False, 'live_set_set_name': None, 'live_set_set_flag': None}
        self.assertIs(vsp.GetSetFlag('geom-1', 4), False)
        self.values['live_get_set_flag'] = True
        self.assertIs(vsp.GetSetFlag('geom-2', 0), True)
        self.assertIsNone(vsp.SetSetName(4, '新名称'))
        self.assertIsNone(vsp.SetSetFlag('geom-1', 4, True))
        self.assertIsNone(vsp.SetSetFlag('geom-1', 4, 0))
        self.assertIsNone(vsp.SetSetFlag('geom-2', 0, 2))
        self.assertEqual(self.calls, [
            ('live_get_set_flag', {'geom_id': 'geom-1', 'set_index': 4}),
            ('live_get_set_flag', {'geom_id': 'geom-2', 'set_index': 0}),
            ('live_set_set_name', {'index': 4, 'name': '新名称'}),
            ('live_set_set_flag', {'geom_id': 'geom-1', 'set_index': 4, 'flag': True}),
            ('live_set_set_flag', {'geom_id': 'geom-1', 'set_index': 4, 'flag': False}),
            ('live_set_set_flag', {'geom_id': 'geom-2', 'set_index': 0, 'flag': True}),
        ])

    def test_validation_does_not_dispatch(self):
        for get in (vsp.GetSetIndex, vsp.GetGeomSet):
            for name in ('', None, 1):
                with self.subTest(get=get.__name__, name=name):
                    with self.assertRaisesRegex(ValueError, 'set name'):
                        get(name)
        for index in (-1, True, 1.0, '1', None):
            with self.subTest(index=index):
                with self.assertRaisesRegex(ValueError, 'index'):
                    vsp.GetGeomSetAtIndex(index)
        self.assertEqual(self.calls, [])

    def test_bridge_error_propagates_for_reads_and_writes(self):
        def reject(op, raw):
            self.calls.append((op, json.loads(raw)))
            return json.dumps({'ok': False, 'error': {'message': 'rejected', 'outcome': 'not_written', 'code': 'GUARD'}})
        vsp.request = reject
        for invoke in (lambda: vsp.GetSetName(2), lambda: vsp.SetSetName(2, 'x'),
                       lambda: vsp.SetSetFlag('g', 2, True)):
            with self.assertRaises(vsp.OpenVSPError) as caught:
                invoke()
            self.assertEqual((str(caught.exception), caught.exception.outcome, caught.exception.code),
                             ('rejected', 'not_written', 'GUARD'))
        self.assertEqual([op for op, _ in self.calls],
                         ['live_set_name', 'live_set_set_name', 'live_set_set_flag'])


if __name__ == '__main__':
    unittest.main()
