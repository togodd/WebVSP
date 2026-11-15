"""Fail if the experimental function diverges from the native source."""
import ast
from pathlib import Path

root = Path(__file__).resolve().parents[3]
original = (root / 'src/python_api/packages/openvsp/openvsp/utilities.py').read_text()
copy = (root / 'web/frontend/src/dualWasmProbe/python/sync_native_utility.py').read_text()

def function(source):
    module = ast.parse(source)
    node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'get_wing_reference_quantities')
    return ast.get_source_segment(source, node)

assert function(original) == function(copy), 'Native function has drifted'
for src, dst in [
    ('openvsp/openvsp/utilities.py', 'openvsp_utilities.py'),
    ('utilities/utilities/__init__.py', 'utilities/__init__.py'),
    ('utilities/utilities/files.py', 'utilities/files.py'),
    ('utilities/utilities/units.py', 'utilities/units.py'),
    ('utilities/utilities/transformations.py', 'utilities/transformations.py'),
]:
    source = root / 'src/python_api/packages' / src
    bundled = root / 'web/frontend/src/dualWasmProbe/python/native' / dst
    assert source.read_bytes() == bundled.read_bytes(), f'Native module drift: {src}'
print('Native utility function and bundled modules match exactly')
