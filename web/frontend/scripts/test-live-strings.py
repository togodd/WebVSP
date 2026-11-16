"""Host tests for byte-bounded live string result decoding."""
import json
from pathlib import Path
import struct
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *_: None)
import openvsp_live as vsp


class StringResultsTest(unittest.TestCase):
    def setUp(self):
        self.rows = [b'', b'a' * 4095 + '€'.encode() + b'b' * (8 * 1024 * 1024), '😀'.encode(), b'tail']
        self.kind = vsp.STRING_DATA
        self.calls = []
        self.mutate = None
        vsp.request = self.request

    def request(self, op, raw):
        args = json.loads(raw)
        self.calls.append(args)
        row, offset = args['row'], args['offset']
        value = self.rows[row] if row < len(self.rows) else b''
        part = value[offset:offset + 4096]
        data = b'VRB2' + struct.pack('<6I', self.kind, len(self.rows), row, len(value), offset, len(part)) + part
        return self.mutate(data) if self.mutate else data

    def test_large_utf8_and_empty(self):
        self.assertEqual(vsp.GetStringResults('r', 'f'), ['', 'a' * 4095 + '€' + 'b' * (8 * 1024 * 1024), '😀', 'tail'])
        self.assertIn((1, 4096), [(c['row'], c['offset']) for c in self.calls])
        self.rows = []
        self.assertEqual(vsp.GetStringResults('r', 'f'), [])

    def test_wrong_type(self):
        self.assertEqual(vsp.GetIntResults('r', 'f'), [])
        self.kind, self.rows = vsp.INT_DATA, [b'']
        self.assertEqual(vsp.GetStringResults('r', 'f'), [])

    def test_invalid_chunks_and_utf8(self):
        self.rows = [b'abc']
        self.mutate = lambda data: data[:-1]
        with self.assertRaises(vsp.OpenVSPError):
            vsp.GetStringResults('r', 'f')
        self.mutate = None
        self.rows = [b'\xff']
        with self.assertRaises(vsp.OpenVSPError):
            vsp.GetStringResults('r', 'f')

    def test_changed_length(self):
        self.rows = [b'a' * 4097]
        def mutate(data):
            if len(self.calls) == 2:
                return data[:16] + struct.pack('<I', 4098) + data[20:]
            return data
        self.mutate = mutate
        with self.assertRaises(vsp.OpenVSPError):
            vsp.GetStringResults('r', 'f')


if __name__ == '__main__':
    unittest.main()
