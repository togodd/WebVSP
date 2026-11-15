"""Contract tests for the adapted OpenVSP high-level wing utility."""
import json
import pathlib
import sys
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
responses = {}
requests = []

async def request(op, raw):
    args = json.loads(raw)
    requests.append((op, args))
    value = responses.get(op)
    if isinstance(value, dict) and value.get('failure'):
        return json.dumps({'ok': False, 'error': {'message': value['failure']}})
    return json.dumps({'ok': True, 'value': value})

sys.modules['webvsp_probe_bridge'] = types.SimpleNamespace(request=request)
import openvsp_wasm as vsp


class WingReferenceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        requests.clear()
        responses.clear()
        responses.update(find_geom='wing-id', wing_reference_parms={'TotalSpan': 12, 'TotalArea': 24, 'TotalChord': 2})

    async def test_id_name_and_priority(self):
        self.assertEqual(await vsp.get_wing_reference_quantities(wing_id='wing-id'), (24, 12, 2))
        self.assertEqual(requests, [('wing_reference_parms', {'geom_id': 'wing-id', 'names': ['TotalSpan', 'TotalArea', 'TotalChord'], 'group': 'WingGeom'})])
        requests.clear()
        self.assertEqual(await vsp.get_wing_reference_quantities(wing_name='Wing'), (24, 12, 2))
        self.assertEqual(requests[0], ('find_geom', {'name': 'Wing', 'index': 0}))
        requests.clear()
        await vsp.get_wing_reference_quantities(wing_name='ignored', wing_id='wing-id')
        self.assertEqual(len(requests), 1)

    async def test_failure_cases(self):
        with self.assertRaises(ValueError):
            await vsp.get_wing_reference_quantities()
        with self.assertRaises(ValueError):
            await vsp.get_wing_reference_quantities(wing_id='wing-id', vsp_instance='other')
        responses['find_geom'] = ''
        with self.assertRaisesRegex(ValueError, 'could not find wing'):
            await vsp.get_wing_reference_quantities(wing_name='missing')
        responses['wing_reference_parms'] = {'failure': 'not a wing'}
        with self.assertRaisesRegex(vsp.OpenVSPError, 'not a wing'):
            await vsp.get_wing_reference_quantities(wing_id='bad')


if __name__ == '__main__':
    unittest.main()
