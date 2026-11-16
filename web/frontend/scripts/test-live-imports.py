"""Exercise the live worker's bundled package layout on host CPython.

The worker installs files under the same package paths as src/python_api/packages.
This test copies them the same way, then checks that desktop, canonical and
legacy imports all resolve to one module object per file.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

probe = Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    shutil.copytree(probe / 'packages', root / 'packages')
    (root / 'openvsp').mkdir()
    shutil.copyfile(probe / 'openvsp_live.py', root / 'openvsp/__init__.py')
    for name in ('utilities.py', 'degen_geom_parse.py', 'surface_patches.py'):
        shutil.copyfile(root / 'packages/openvsp/openvsp' / name, root / 'openvsp' / name)
    shutil.copytree(root / 'packages/degen_geom/degen_geom', root / 'degen_geom')
    shutil.copytree(root / 'packages/utilities/utilities', root / 'utilities')
    shutil.copyfile(probe / 'live_imports.py', root / 'live_imports.py')
    (root / 'sync_bridge.py').write_text('def request(*args):\n    raise AssertionError("unexpected bridge call")\n')
    code = '''
import importlib, sys
import live_imports
import openvsp
for canonical, legacy in [
    ('openvsp.surface_patches', 'surface_patches'),
    ('openvsp.degen_geom_parse', 'degen_geom_parse'),
    ('openvsp.utilities', 'openvsp_utilities'),
]:
    a, b = (importlib.import_module(n) for n in ((canonical, legacy) if ORDER else (legacy, canonical)))
    assert a is b, (canonical, legacy)
    assert sys.modules[canonical] is sys.modules[legacy]
assert openvsp.surface_patches is sys.modules['surface_patches']
assert openvsp.degen_geom_parse is sys.modules['degen_geom_parse']
assert openvsp.utilities is sys.modules['openvsp_utilities']
assert openvsp.degen_geom_parse.vsp_module is openvsp
assert openvsp.surface_patches.vsp_module is openvsp
assert openvsp.utilities.vsp_module is openvsp
assert openvsp.export_surface_patches is openvsp.surface_patches.export_surface_patches
assert openvsp.SurfaceComponent is openvsp.surface_patches.SurfaceComponent
assert openvsp.parse_degen_geom is openvsp.degen_geom_parse.parse_degen_geom
assert openvsp.get_wing_reference_quantities is openvsp.utilities.get_wing_reference_quantities
assert openvsp.parse_results_object is not openvsp.utilities.parse_results_object
assert openvsp.degen_geom_parse.dg is importlib.import_module('degen_geom')
import utilities.transformations as transforms
assert transforms.TransMatrix is importlib.import_module('degen_geom.degen_geom').TransMatrix
assert openvsp.get_instance() is openvsp
'''
    for order in (True, False):
        subprocess.run([sys.executable, '-c', f'ORDER = {order}\n' + code], cwd=root, check=True)
print('Live import aliases, identity and upstream cycles: OK')
