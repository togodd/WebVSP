"""Host tests of bounded live numeric result decoding and getter compatibility."""
import json
import math
from pathlib import Path
import struct
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *_: None)
import openvsp_live as vsp


class BinaryResultsTest(unittest.TestCase):
    def setUp(self):
        self.kind = vsp.DOUBLE_DATA
        self.rows = [[1.0, float('nan'), float('inf'), float('-inf')]]
        self.calls = []
        self.mutate = None
        vsp.request = self.request

    def request(self, op, raw):
        args = json.loads(raw)
        self.calls.append((op, args))
        if op == 'live_result_type':
            return json.dumps({'ok': True, 'value': self.kind})
        row, offset = args['row'], args['offset']
        values = self.rows[row] if row < len(self.rows) else []
        part = values[offset:offset + 4096]
        fmt = 'i' if self.kind in (vsp.INT_DATA, vsp.INT_MATRIX_DATA) else 'd'
        data = b'VRB2' + struct.pack('<6I', self.kind, len(self.rows), row, len(values), offset, len(part)) + struct.pack('<%d%s' % (len(part), fmt), *part)
        return self.mutate(data) if self.mutate else data

    def test_nonfinite_and_large_chunks(self):
        self.rows = [[1.0] * 4096 + [float('nan'), float('inf'), float('-inf')]]
        result = vsp.GetDoubleResults('r', 'f')
        self.assertEqual(len(result), 4099)
        self.assertTrue(math.isnan(result[-3]))
        self.assertEqual(result[-2:], [float('inf'), float('-inf')])
        self.assertEqual([x[1]['offset'] for x in self.calls if x[0] == 'live_result_binary_field'], [0, 4096])

    def test_ragged_empty_and_vec3d(self):
        self.kind = vsp.DOUBLE_MATRIX_DATA
        self.rows = [[], [1, 2], [], [3] * 4097]
        self.assertEqual(vsp.GetDoubleMatResults('r', 'f'), self.rows)
        self.rows = []
        self.assertEqual(vsp.GetDoubleMatResults('r', 'f'), [])
        self.kind = vsp.VEC3D_DATA
        self.rows = [[1, 2, 3]]
        p = vsp.GetVec3dResults('r', 'f')[0]
        self.assertEqual((p.x(), p.y(), p.z()), (1, 2, 3))
        self.assertEqual(repr(p), 'vec3d(1.0, 2.0, 3.0)')

    def test_wrong_type_and_invalid_payload(self):
        self.assertEqual(vsp.GetIntResults('r', 'f'), [])
        self.mutate = lambda data: data[:-1]
        with self.assertRaises(vsp.OpenVSPError): vsp.GetDoubleResults('r', 'f')
        self.mutate = lambda data: data[:12] + struct.pack('<I', 9) + data[16:]
        with self.assertRaises(vsp.OpenVSPError): vsp.GetDoubleResults('r', 'f')

    def test_integer(self):
        self.kind, self.rows = vsp.INT_DATA, [[-2147483648, 2147483647]]
        self.assertEqual(vsp.GetIntResults('r', 'f'), self.rows[0])


if __name__ == '__main__':
    unittest.main()
