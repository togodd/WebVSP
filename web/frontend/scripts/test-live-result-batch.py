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
    def test_explicit_batch_statuses_and_vro1(self):
        ids = ['ok', 'missing']
        payload = b'VRM1' + u(2) + u(0) + u(len(snapshot())) + snapshot() + u(1) + u(0)
        calls = []
        vsp.request = lambda op, raw: calls.append((op, json.loads(raw))) or payload
        result = vsp.GetResultSnapshots(ids)
        self.assertEqual([x['status'] for x in result], ['ok', 'unknown'])
        self.assertEqual(result[0]['data']['name'], 'Sample')
        self.assertEqual(calls, [('live_result_objects', {'result_ids': ids})])

    def test_batch_rejects_implicit_or_malformed_input(self):
        with self.assertRaises(ValueError): vsp.GetResultSnapshots(['a\x1fb'])
        with self.assertRaises(ValueError): vsp.GetResultSnapshots([])
        with self.assertRaises(ValueError): vsp.GetResultSnapshots(['x'] * 33)
        vsp.request = lambda *_: b'VRM1' + u(1) + u(0) + u(0)
        with self.assertRaisesRegex(Exception, 'Invalid batch result item'):
            vsp.GetResultSnapshots(['x'])

    def test_capabilities(self):
        vsp.request = lambda op, raw: json.dumps({'ok': True, 'value': {'max_ids': 32}})
        self.assertEqual(vsp.GetResultSnapshotCapabilities()['max_ids'], 32)

    def test_instance_validation_precedes_bridge(self):
        calls = []
        vsp.request = lambda *args: calls.append(args) or snapshot()
        with self.assertRaisesRegex(ValueError, 'Multiple OpenVSP instances'):
            vsp.parse_results_object('root', object())
        self.assertEqual(calls, [])
        self.assertIsNone(vsp._RESULT_PARSE_CACHE)
        self.assertEqual(vsp.parse_results_object('root', vsp).ref, ['another_result_id'])

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

    def test_matches_original_parser_all_supported_types(self):
        data = (b'VRO1' + text('Sample') + u(5) +
                text('ints') + u(1) + vec('i', [-2, 0, 3]) +
                text('doubles') + u(2) + vec('d', [1.25, -0.0]) +
                text('strings') + u(3) + u(2) + text('') + text('结果') +
                text('matrix') + u(6) + u(2) + vec('d', []) + vec('d', [4.5]) +
                text('points') + u(4) + u(1) + struct.pack('<3d', 1, 2, 3))
        class Point:
            def x(self): return 1
            def y(self): return 2
            def z(self): return 3
        class Original:
            INT_DATA, DOUBLE_DATA, STRING_DATA, VEC3D_DATA, DOUBLE_MATRIX_DATA = 1, 2, 3, 4, 6
            def get_instance(self, instance=None): return self
            def GetAllDataNames(self, _): return ['ints', 'doubles', 'strings', 'matrix', 'points']
            def GetResultsName(self, _): return 'Sample'
            def GetResultsType(self, _, name): return {'ints': 1, 'doubles': 2, 'strings': 3, 'matrix': 6, 'points': 4}[name]
            def GetIntResults(self, *_): return [-2, 0, 3]
            def GetDoubleResults(self, *_): return [1.25, -0.0]
            def GetStringResults(self, *_): return ['', '结果']
            def GetDoubleMatResults(self, *_): return [[], [4.5]]
            def GetVec3dResults(self, *_): return [Point()]
        original_module = namespace['vsp_module']
        try:
            namespace['vsp_module'] = Original()
            expected = namespace['parse_results_object']('root')
        finally:
            namespace['vsp_module'] = original_module
        calls = []
        vsp.request = lambda op, raw: calls.append(op) or data
        actual = vsp.parse_results_object('root')
        self.assertEqual(type(actual).__name__, type(expected).__name__)
        self.assertEqual(actual._fields, expected._fields)
        self.assertEqual(actual, expected)
        self.assertEqual(math.copysign(1, actual.doubles[1]), -1)
        self.assertEqual(calls, ['live_result_object'])

    def test_decoder_size_and_count_boundaries(self):
        def decode(data):
            vsp.request = lambda *_: data
            return vsp._batch_result_cache('root')

        # The byte limit includes all headers; test exactly at and above it.
        prefix = b'VRO1' + u(512 * 1024 - 12)
        exact = prefix + b'A' * (512 * 1024 - 12) + u(0)
        self.assertEqual(len(exact), 512 * 1024)
        self.assertIsNotNone(decode(exact))
        self.assertIsNone(decode(exact + b'\0'))
        fields = lambda n: b'VRO1' + text('Sample') + u(n) + b''.join(
            text('f%d' % i) + u(1) + vec('i', []) for i in range(n))
        self.assertEqual(len(decode(fields(1024))['names']), 1024)
        self.assertIsNone(decode(fields(1025)))
        for n in (0, 32768):
            data = b'VRO1' + text('Sample') + u(1) + text('x') + u(1) + vec('i', [7] * n)
            self.assertEqual(len(decode(data)['values'][('x', 0, 1)]), n)
        self.assertIsNone(decode(b'VRO1' + text('Sample') + u(1) + text('x') + u(1) + u(32769)))

    def test_malformed_and_unsupported_snapshots(self):
        def decode(data):
            vsp.request = lambda *_: data
            return vsp._batch_result_cache('root')
        base = b'VRO1' + text('Sample') + u(1) + text('x')
        cases = [b'', b'VRO2' + text('Sample') + u(0), snapshot()[:-1],
                 snapshot() + b'\0', b'VRO1' + u(1) + b'\xff' + u(0),
                 base + u(1) + u(2) + struct.pack('<i', 1),
                 base + u(3) + u(32769), base + u(6) + u(32769),
                 base + u(4) + u(32769), base + u(5),
                 b'VRO1' + text('Sample') + u(2) +
                 (text('x') + u(1) + vec('i', [])) * 2]
        for data in cases:
            with self.subTest(data=data[:30]):
                self.assertIsNone(decode(data))

    def test_fallback_and_order(self):
        for batch in (json.dumps({'ok': True, 'value': None}),
                      json.dumps({'ok': False, 'error': {'message': 'old engine'}}),
                      b'VRO1\0', b'VRO1' + bytes(512 * 1024),
                      b'VRO1' + text('X') + u(1025),
                      b'VRO1' + text('X') + u(1) + text('x') + u(1) + u(32769),
                      b'VRO1' + text('X') + u(1) + text('x') + u(5)):
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
