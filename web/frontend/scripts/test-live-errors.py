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
