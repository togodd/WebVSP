"""Host tests for the live result-management facade (no engine)."""
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *args: None)
import openvsp_live as vsp  # noqa: E402


class ResultApiTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.reply = {'ok': True, 'value': None}
        def request(op, raw):
            self.calls.append((op, json.loads(raw)))
            return json.dumps(self.reply)
        vsp.request = request

    def test_find_and_count(self):
        vsp.FindResultsID('DegenGeom', 2)
        self.assertEqual(self.calls[-1], ('live_find_results_id', {'name': 'DegenGeom', 'index': 2}))
        vsp.FindLatestResultsID('DegenGeom')
        self.assertEqual(self.calls[-1], ('live_find_latest_results_id', {'name': 'DegenGeom'}))
        vsp.GetNumResults('DegenGeom')
        self.assertEqual(self.calls[-1], ('live_num_results', {'name': 'DegenGeom'}))
        vsp.GetAllResultsNames()
        self.assertEqual(self.calls[-1][0], 'live_results_names')

    def test_validation(self):
        with self.assertRaisesRegex(ValueError, 'name'):
            vsp.FindResultsID('')
        with self.assertRaisesRegex(ValueError, 'index'):
            vsp.FindResultsID('x', -1)
        with self.assertRaisesRegex(ValueError, 'index'):
            vsp.FindResultsID('x', True)
        with self.assertRaisesRegex(ValueError, 'name'):
            vsp.FindLatestResultsID('')
        with self.assertRaisesRegex(ValueError, 'name'):
            vsp.GetNumResults('')
        self.assertEqual(self.calls, [])

    def test_delete(self):
        vsp.DeleteResult('res-1')
        self.assertEqual(self.calls[-1], ('live_delete_result', {'result_id': 'res-1'}))
        vsp.DeleteAllResults()
        self.assertEqual(self.calls[-1][0], 'live_delete_all_results')
        with self.assertRaisesRegex(ValueError, 'result ID'):
            vsp.DeleteResult('')

    def test_delete_failure_is_an_unknown_write(self):
        self.reply = {'ok': False, 'error': {'message': 'engine failed'}, 'value': None}
        with self.assertRaises(vsp.OpenVSPError) as caught:
            vsp.DeleteResult('res-1')
        self.assertEqual(caught.exception.outcome, 'unknown')

    def test_empty_find_result(self):
        self.reply = {'ok': True, 'value': ''}
        self.assertEqual(vsp.FindResultsID('missing'), '')
        self.assertEqual(vsp.FindLatestResultsID('missing'), '')


if __name__ == '__main__':
    unittest.main()
