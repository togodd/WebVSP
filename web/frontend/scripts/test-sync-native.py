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
print('Native utility function matches exactly')
