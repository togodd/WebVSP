"""Host tests for parameter metadata and SetParmValUpdate."""
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *args: None)
import openvsp_live as vsp  # noqa: E402


class ParmApiTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.reply = {'ok': True, 'value': None}
        def request(op, raw):
            self.calls.append((op, json.loads(raw)))
            return json.dumps(self.reply)
        vsp.request = request

    def test_type_constants(self):
        self.assertEqual((vsp.PARM_DOUBLE_TYPE, vsp.PARM_INT_TYPE, vsp.PARM_BOOL_TYPE), (0, 1, 2))
        self.assertEqual(vsp.PARM_POWER_INT_TYPE, 6)

    def test_get_parm_val_overloads(self):
        vsp.GetParmVal('pid')
        self.assertEqual(self.calls[-1], ('live_parm_value_by_id', {'parm_id': 'pid'}))
        vsp.GetParmVal('g', 'Span', 'WingGeom')
        self.assertEqual(self.calls[-1], ('live_parm_get', {'geom_id': 'g', 'key': 'WingGeom\x1fSpan'}))
        with self.assertRaises(TypeError):
            vsp.GetParmVal('g', 'Span')

    def test_metadata(self):
        vsp.GetParmType('pid')
        self.assertEqual(self.calls[-1], ('live_parm_type', {'parm_id': 'pid'}))
        self.reply = {'ok': True, 'value': {'lower': 0.1, 'upper': 100.0}}
        self.assertEqual(vsp.GetParmLowerLimit('pid'), 0.1)
        self.assertEqual(vsp.GetParmUpperLimit('pid'), 100.0)
        self.assertEqual(self.calls[-1][0], 'live_parm_limits')
        vsp.GetParmActiveFlag('pid')
        self.assertEqual(self.calls[-1][0], 'live_parm_active')
        vsp.FindParm('g', 'Span', 'WingGeom')
        self.assertEqual(self.calls[-1], ('live_parm_find', {'container_id': 'g', 'key': 'WingGeom\x1fSpan'}))
        vsp.GetParmName('pid')
        self.assertEqual(self.calls[-1][0], 'live_parm_name')
        vsp.GetParmGroupName('pid')
        self.assertEqual(self.calls[-1][0], 'live_parm_group')
        vsp.GetParmDisplayGroupName('pid')
        self.assertEqual(self.calls[-1][0], 'live_parm_display_group')

    def test_set_update_by_id_and_name(self):
        vsp.SetParmValUpdate('pid', 4.5)
        self.assertEqual(self.calls[-1], ('live_parm_set_update', {'parm_id': 'pid', 'value': 4.5}))
        self.reply = {'ok': True, 'value': 'found-pid'}
        vsp.SetParmValUpdate('g', 'Span', 'WingGeom', 6)
        self.assertEqual(self.calls[-2][0], 'live_parm_find')
        self.assertEqual(self.calls[-1], ('live_parm_set_update', {'parm_id': 'found-pid', 'value': 6.0}))
        with self.assertRaises(TypeError):
            vsp.SetParmValUpdate('pid')
        with self.assertRaisesRegex(ValueError, 'number'):
            vsp.SetParmValUpdate('pid', 'x')

    def test_missing_parm_error(self):
        self.reply = {'ok': True, 'value': ''}
        with self.assertRaisesRegex(vsp.OpenVSPError, 'not found'):
            vsp.SetParmValUpdate('g', 'Nope', 'WingGeom', 1)

    def test_validation(self):
        for call in (lambda: vsp.GetParmType(''), lambda: vsp.GetParmActiveFlag(''),
                     lambda: vsp.GetParmName(''), lambda: vsp.FindParm('', 'x', 'y'),
                     lambda: vsp.FindParm('g', '', 'y')):
            with self.assertRaises(ValueError):
                call()
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
