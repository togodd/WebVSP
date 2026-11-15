"""Host-side signature, mapping, error and timeout tests for the restricted facade."""
import inspect
import json
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'))
requests = []
response = {'ok': True, 'value': 'id'}

def request(op, raw):
    requests.append((op, json.loads(raw)))
    if op == 'add_geom' and response.get('timeout'):
        raise RuntimeError('timed out')
    return json.dumps(response)

sys.modules['sync_bridge'] = types.SimpleNamespace(request=request)
import openvsp as vsp

class FacadeTest(unittest.TestCase):
    def setUp(self):
        requests.clear()
        response.clear()
        response.update(ok=True, value='id')

    def test_signatures_and_mapping(self):
        self.assertEqual(str(inspect.signature(vsp.AddGeom)), "(type, parent='')")
        self.assertEqual(str(inspect.signature(vsp.Update)), '(update_managers=True)')
        vsp.AddGeom(type='WING')
        vsp.FindGeom('WingGeom', 0)
        vsp.GetParmVal('g', 'X_Rel_Location', 'XForm')
        vsp.SetParmVal('g', 'X_Rel_Location', 'XForm', 2.0)
        vsp.Update()
        self.assertEqual(requests, [
            ('add_geom', {'type': 'WING', 'parent': ''}),
            ('find_geom', {'name': 'WingGeom', 'index': 0}),
            ('parm_value', {'geom': 'g', 'name': 'X_Rel_Location', 'group': 'XForm'}),
            ('set_parm', {'geom': 'g', 'name': 'X_Rel_Location', 'group': 'XForm', 'value': 2.0}),
            ('update', {'update_managers': True}),
        ])
        self.assertIs(vsp.get_instance(None), vsp)
        with self.assertRaises(ValueError): vsp.get_instance('other')

    def test_errors_and_timeout(self):
        response.clear()
        response.update(ok=False, error={'message': 'stale', 'outcome': 'not_written', 'code': 'STALE_MODEL'})
        with self.assertRaises(vsp.OpenVSPError) as caught: vsp.Update()
        self.assertEqual((caught.exception.outcome, caught.exception.code), ('not_written', 'STALE_MODEL'))
        response.clear()
        response.update(timeout=True)
        with self.assertRaises(vsp.OpenVSPError) as caught: vsp.AddGeom('WING')
        self.assertEqual(caught.exception.outcome, 'unknown')

if __name__ == '__main__': unittest.main()
