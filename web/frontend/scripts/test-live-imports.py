"""Exercise the live worker's bundled import layout on host CPython."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

probe = Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python'
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'openvsp').mkdir()
    shutil.copyfile(probe / 'openvsp_live.py', root / 'openvsp/__init__.py')
    for name in ('degen_geom_parse.py', 'surface_patches.py', 'openvsp_utilities.py'):
        shutil.copyfile(probe / 'native' / name, root / name)
    for name in ('degen_geom', 'utilities'):
        shutil.copytree(probe / 'native' / name, root / name)
    shutil.copyfile(probe / 'live_imports.py', root / 'live_imports.py')
    (root / 'sync_bridge.py').write_text('def request(*args):\n    raise AssertionError("unexpected bridge call")\n')
    code = '''
import importlib, sys
import live_imports
for canonical, legacy in [
    ('openvsp.surface_patches', 'surface_patches'),
    ('openvsp.degen_geom_parse', 'degen_geom_parse'),
    ('openvsp.utilities', 'openvsp_utilities'),
    ('openvsp.degen_geom', 'degen_geom'),
    ('openvsp.degen_geom.degen_geom', 'degen_geom.degen_geom'),
]:
    a, b = (importlib.import_module(n) for n in ((canonical, legacy) if ORDER else (legacy, canonical)))
    assert a is b, (canonical, legacy)
    assert sys.modules[canonical] is sys.modules[legacy]
import openvsp
from openvsp import surface_patches, degen_geom_parse, utilities
assert surface_patches is openvsp.surface_patches
assert degen_geom_parse.vsp_module is openvsp
assert surface_patches.vsp_module is openvsp
assert utilities.vsp_module is openvsp
assert openvsp.export_surface_patches is surface_patches.export_surface_patches
assert openvsp.SurfaceComponent is surface_patches.SurfaceComponent
assert openvsp.parse_degen_geom is degen_geom_parse.parse_degen_geom
assert openvsp.get_wing_reference_quantities is utilities.get_wing_reference_quantities
assert openvsp.parse_results_object is not utilities.parse_results_object
assert degen_geom_parse.dg is openvsp.degen_geom
import utilities.transformations as transforms
assert transforms.TransMatrix is importlib.import_module('degen_geom.degen_geom').TransMatrix
assert openvsp.get_instance() is openvsp
'''
    for order in (True, False):
        subprocess.run([sys.executable, '-c', f'ORDER = {order}\n' + code], cwd=root, check=True)
print('Live import aliases, identity and upstream cycles: OK')
