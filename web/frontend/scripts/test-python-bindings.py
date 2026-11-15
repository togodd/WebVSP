"""Host-side contract test for generated wrappers; no OpenVSP engine required."""
import asyncio
import inspect
import json
import pathlib
import sys
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
requests = []

async def request(operation, arguments):
    requests.append((operation, json.loads(arguments)))
    if operation == 'geom_name':
        return json.dumps({'ok': False, 'error': {'message': 'missing', 'outcome': 'not_written'}})
    return json.dumps({'ok': True, 'value': ['id'] if operation in ('find_geoms', 'parm_ids') else 'id'})

sys.modules['webvsp_probe_bridge'] = types.SimpleNamespace(request=request)
import openvsp_wasm as vsp


class BindingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        requests.clear()

    async def test_generated_mapping(self):
        self.assertEqual(str(inspect.signature(vsp.AddGeom)), "(type, parent='')")
        self.assertEqual(await vsp.AddGeom(type='WING'), 'id')
        self.assertEqual(await vsp.FindGeoms(), ['id'])
        self.assertEqual(await vsp.GetGeomTypeName(geom_id='g'), 'id')
        self.assertEqual(await vsp.GetGeomParmIDs(geom_id='g'), ['id'])
        self.assertEqual(requests, [('add_geom', {'geom_type': 'WING', 'parent': ''}), ('find_geoms', {}), ('geom_type', {'geom_id': 'g'}), ('parm_ids', {'geom_id': 'g'})])
        with self.assertRaises(vsp.OpenVSPError) as caught:
            await vsp.GetGeomName('g')
        self.assertEqual(caught.exception.outcome, 'not_written')

    def test_enums(self):
        self.assertEqual([vsp.PARM_DOUBLE_TYPE, vsp.PARM_INT_TYPE, vsp.PARM_BOOL_TYPE, vsp.PARM_FRACTION_TYPE, vsp.PARM_LIMITED_INT_TYPE, vsp.PARM_NOTEQ_TYPE, vsp.PARM_POWER_INT_TYPE], list(range(7)))


if __name__ == '__main__':
    unittest.main()
