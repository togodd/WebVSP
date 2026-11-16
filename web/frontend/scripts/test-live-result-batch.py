"""Host-side VRO1 decoding and transparent parser regression tests."""
import json
import math
from pathlib import Path
import struct
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
sys.modules['sync_bridge'] = types.SimpleNamespace(request=lambda *args: None)
import openvsp_live as vsp

# Exercise the real upstream parser without its unrelated numpy dependencies.
source = (Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python/native/openvsp_utilities.py').read_text()
namespace = {'namedtuple': __import__('collections').namedtuple,
             'vsp_module': vsp,
             'convert_double_tuple_to_list_matrix': lambda x: [list(r) for r in x],
             'convert_vec3d_array_to_list_matrix': lambda x: [[v.x(), v.y(), v.z()] for v in x]}
exec(source[source.index('def parse_results_object('):source.index('def get_wing_reference_quantities(')], namespace)
sys.modules['openvsp_utilities'] = types.SimpleNamespace(parse_results_object=namespace['parse_results_object'])

def u(n): return struct.pack('<I', n)
def text(s):
    b = s.encode('utf-8')
    return u(len(b)) + b
def vec(fmt, values): return u(len(values)) + struct.pack('<%d%s' % (len(values), fmt), *values)
def snapshot():
    return (b'VRO1' + text('Sample') + u(4) +
            text('ref') + u(3) + u(1) + text('another_result_id') +
            text('values') + u(2) + vec('d', [float('nan'), float('inf'), -float('inf')]) +
            text('matrix') + u(6) + u(3) + vec('d', [1, 2]) + vec('d', []) + vec('d', [3]) +
            text('points') + u(4) + u(1) + struct.pack('<3d', 1, 2, 3))

class BatchTest(unittest.TestCase):
    def test_batch_namedtuple_and_ieee(self):
        calls = []
        def request(op, raw):
            calls.append((op, json.loads(raw)))
            return snapshot()
        vsp.request = request
        result = vsp.parse_results_object('root')
        self.assertEqual(type(result).__name__, 'Sample')
        self.assertEqual(result._fields, ('ref', 'values', 'matrix', 'points'))
        self.assertEqual(result.ref, ['another_result_id'])
        self.assertTrue(math.isnan(result.values[0]))
        self.assertEqual(result.values[1:], [float('inf'), -float('inf')])
        self.assertEqual(result.matrix, [[1, 2], [], [3]])
        self.assertEqual(result.points, [[1, 2, 3]])
        self.assertEqual(calls, [('live_result_object', {'result_id': 'root'})])
        self.assertIsNone(vsp._RESULT_PARSE_CACHE)

    def test_fallback_and_order(self):
        for batch in (json.dumps({'ok': True, 'value': None}), b'VRO1\0', b'VRO1' + text('X') + u(1) + text('x') + u(5)):
            calls = []
            def request(op, raw):
                calls.append(op)
                answers = {'live_result_names': ['x'], 'live_result_name': 'Sample', 'live_result_type': 1}
                if op == 'live_result_object': return batch
                if op == 'live_result_binary_field': return b'VRB2' + struct.pack('<6Ii', 1, 1, 0, 1, 0, 1, 7)
                return json.dumps({'ok': True, 'value': answers[op]})
            vsp.request = request
            self.assertEqual(vsp.parse_results_object('root').x, [7])
            self.assertEqual(calls, ['live_result_object', 'live_result_names', 'live_result_name', 'live_result_type', 'live_result_binary_field'])

if __name__ == '__main__': unittest.main()
