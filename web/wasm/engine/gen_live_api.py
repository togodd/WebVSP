#!/usr/bin/env python3
"""Generate the signature-driven Python bridge for the OpenVSP geometry API.

The hand-written bridge in engine.cpp / syncProbe.ts / openvsp_live.py covers the
geometry work that needs argument packing or result decoding. Everything that is
a plain "string in, value out" call is covered here instead: this script reads
the native declarations, keeps the ones with simple input-only parameters, and
emits

  web/wasm/engine/live_api_table.inc                  C++ dispatch table
  web/frontend/src/dualWasmProbe/python/live_api_table.py   Python facade table

Both files are generated together, so the argument shapes cannot drift. Run it
from the repository root:

    python3 web/wasm/engine/gen_live_api.py
"""
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HEADER = ROOT / 'src/geom_api/VSP_Geom_API.h'
FACADE = ROOT / 'web/frontend/src/dualWasmProbe/python/openvsp_live.py'
CPP_OUT = ROOT / 'web/wasm/engine/live_api_table.inc'
PY_OUT = ROOT / 'web/frontend/src/dualWasmProbe/python/live_api_table.py'
SMOKE_OUT = ROOT / 'web/wasm/engine/api_smoke_spec.json'

# Input shapes the generic bridge understands. The key is the Python signature
# the facade exposes; the value lists the C++ parameter types.
SHAPES = {
    'v': [],
    's': ['string'],
    'i': ['int'],
    'n': ['string', 'int'],
    'ss': ['string', 'string'],
    'sb': ['string', 'bool'],
    'ns': ['int', 'string'],
    'nn': ['int', 'int'],
    'ib': ['int', 'bool'],
    'sii': ['string', 'int', 'int'],
    'sis': ['string', 'int', 'string'],
    'sd': ['string', 'double'],
    'sdd': ['string', 'double', 'double'],
    'sbi': ['string', 'bool', 'int'],
    'siiS': ['string', 'int', 'int'],
    'I0': [],
    'S0': [],
    'B0': [],
    'V0': [],
    'L': ['string'],
    'Li': ['string', 'int'],
    'E': ['string'],
    'D0': [],
    'd': ['double'],
    'I1': ['int'],
    'D1': ['int'],
    'Dd': ['double'],
    'Ddd': ['double', 'double'],
    'Ei': ['string', 'int'],
    'Ed': ['string', 'double'],
    'Vint': ['string'],
    'ssi': ['string', 'string', 'int'],
    'iss': ['int', 'string', 'string'],
    'sidd': ['string', 'int', 'double', 'double'],
    'Ev': ['string'],
    'EvI': ['string', 'int'],
    'sv': ['string', 'vector<vec3d>'],
    'sL': ['string', 'int', 'vector<double>'],
    'S': ['string'],
    'I': ['string'],
    'D': ['string'],
    'B': ['string'],
    'SS': ['string', 'string'],
    'Si': ['string', 'int'],
    'Ii': ['string', 'int'],
    'N': ['int'],
    'Vi': ['int'],
    'V': [],
    'Vs': ['string'],
}

RETURNS = {'v': 'void', 's': 'void', 'i': 'void', 'n': 'void', 'ss': 'void', 'sb': 'void',
           'ns': 'void', 'nn': 'void', 'ib': 'void', 'sii': 'void',
           'sis': 'void', 'sd': 'void', 'sdd': 'void', 'ssi': 'void', 'iss': 'void',
           'sidd': 'void', 'sv': 'void', 'sL': 'void', 'd': 'void',
           'sbi': 'int', 'siiS': 'string',
           'S': 'string', 'SS': 'string', 'Si': 'string', 'N': 'string', 'S0': 'string',
           'I': 'int', 'Ii': 'int', 'D': 'double', 'B': 'bool', 'I0': 'int', 'B0': 'bool',
           'L': 'vector<double>', 'Li': 'vector<double>', 'E': 'vec3d',
           'Ei': 'vec3d', 'Ed': 'vec3d', 'Vint': 'vector<int>', 'Ev': 'vector<vec3d>',
           'EvI': 'vector<vec3d>', 'D0': 'double', 'D1': 'double', 'Dd': 'double',
           'Ddd': 'double', 'I1': 'int',
           'V': 'vector<string>', 'Vs': 'vector<string>', 'Vi': 'vector<string>',
           'V0': 'vector<string>'}

# Coordinates out-parameters (`double &u_out`) are not representable here; those
# APIs keep their hand-written bridges.
def is_output_param(raw):
    """A non-const reference parameter writes back; those APIs stay hand-written."""
    raw = raw.split('=')[0].strip()
    parts = [p for p in raw.split() if p]
    if len(parts) < 2:
        return False
    type_text = ' '.join(parts[:-1])
    return '&' in type_text and not re.search(r'\bconst\b', type_text)


TEMPLATES = ('vector<string>', 'vector<double>', 'vector<int>', 'vector<vec3d>', 'vector<vec2d>',
             'vector<vector<double>>', 'vector<vector<string>>')


def simple_type(raw):
    text = re.sub(r'\bconst\b', '', raw).replace('&', '').strip()
    text = re.sub(r'\bstd::', '', text)
    text = re.sub(r'\s+', ' ', text)
    flat = text.replace(' ', '')
    for name in TEMPLATES:
        if flat == name:
            return name
    return text


def parse():
    header = HEADER.read_text()
    header = re.sub(r'/\*.*?\*/', '', header, flags=re.S)
    header = re.sub(r'//[^\n]*', '', header)
    facade = FACADE.read_text()
    have = {node.name for node in ast.parse(facade).body if isinstance(node, ast.FunctionDef)}
    decls = re.findall(r'\bextern\s+([^;]*?)\b([A-Za-z_]\w*)\s*\(([^;]*)\)\s*;', header, re.S)
    seen = {}
    for ret, name, args in decls:
        params = []
        defaults = []
        if args.strip() and args.strip() != 'void':
            for raw in args.split(','):
                if is_output_param(raw):
                    params = None
                    break
                text = raw.split('=')[0].strip()
                parts = text.rsplit(' ', 1)
                if len(parts) != 2:
                    params = None
                    break
                params.append(simple_type(parts[0]))
                piece = raw.split('=', 1)
                defaults.append(piece[1].strip() if len(piece) == 2 else None)
        if params is None:
            continue
        seen.setdefault(name, set()).add((simple_type(ret), tuple(params), tuple(defaults)))
    rows = []
    for name, variants in seen.items():
        if name in have or len(variants) != 1:
            continue
        ret, params, defaults = next(iter(variants))
        for shape, want in SHAPES.items():
            if tuple(want) == params and RETURNS[shape] == ret:
                rows.append((name, shape, defaults))
                break
    rows.sort()
    return rows


def default_value(text):
    """Turn a native default literal into something the facade can apply."""
    if text is None:
        return None
    text = text.strip()
    if text == 'true':
        return ('lit', True)
    if text == 'false':
        return ('lit', False)
    if re.fullmatch(r'-?\d+', text):
        return ('lit', int(text))
    if re.fullmatch(r'-?\d*\.\d*', text) or re.fullmatch(r'-?\d+e-?\d+', text):
        return ('lit', float(text))
    if text in ('string()', '""', "''"):
        return ('lit', '')
    if re.fullmatch(r'[A-Za-z_]\w*', text):
        # An enum or constant name; resolved from the facade at call time.
        return ('name', text)
    return None


CPP_HEAD = '''// Generated by web/wasm/engine/gen_live_api.py from src/geom_api/VSP_Geom_API.h.
// Do not edit: change the generator and rerun it.
//
// One line per native function whose parameters are all plain inputs and whose
// return is a scalar or a string list. The shape letter is the Python signature
// the facade exposes; `liveApi` dispatches on it.
'''

PY_HEAD = '''"""Generated by web/wasm/engine/gen_live_api.py from src/geom_api/VSP_Geom_API.h.

Maps a function name to its argument shape. openvsp_live.py builds the public
wrappers from this table, so the native names stay exactly as declared.
"""

# shape -> (parameter types, return type)
SHAPES = {
'''


def cpp_tables(rows):
    groups = {}
    for name, shape, _ in rows:
        groups.setdefault(shape, []).append(name)
    out = [CPP_HEAD]
    for shape in sorted(groups):
        names = groups[shape]
        out.append(f'\n// {shape}: {RETURNS[shape]} (' + ', '.join(SHAPES[shape]) + f')  -- {len(names)} functions')
    return out, groups


def write_cpp(rows):
    out, groups = cpp_tables(rows)
    params = {'v': '', 's': 'const string &a', 'i': 'int a', 'n': 'const string &a, int b',
              'ss': 'const string &a, const string &b', 'sb': 'const string &a, bool b',
              'ns': 'int a, const string &b', 'nn': 'int a, int b', 'ib': 'int a, bool b',
              'sii': 'const string &a, int b, int c',
              'sdd': 'const string &a, double b, double c',
              'dd': 'double a, double b',
              'sbi': 'const string &a, bool b, int c',
              'siiS': 'const string &a, int b, int c',
              'si': 'const string &a, int b',
              'sd': 'const string &a, double b',
              'ssi': 'const string &a, const string &b, int c',
              'iss': 'int a, const string &b, const string &c',
              'sidd': 'const string &a, int b, double c, double d',
              'd': 'double a',
              'sv': 'const string &a, const vector<vec3d> &b',
              'sL': 'const string &a, int b, const vector<double> &c',
              'sis': 'const string &a, int b, const string &c', 'sd': 'const string &a, double b'}
    call = {'v': '', 's': 'a', 'i': 'a', 'n': 'a, b', 'ss': 'a, b', 'sb': 'a, b',
            'ns': 'a, b', 'nn': 'a, b', 'ib': 'a, b', 'sii': 'a, b, c',
            'sis': 'a, b, c', 'sd': 'a, b', 'sdd': 'a, b, c', 'ssi': 'a, b, c',
            'dd': 'a, b', 'si': 'a, b', 'sbi': 'a, b, c', 'siiS': 'a, b, c',
            'iss': 'a, b, c', 'sidd': 'a, b, c, d', 'd': 'a', 'sv': 'a, b', 'sL': 'a, b, c'}
    # Shapes with the same parameters share one argument signature.
    alias = {'S': 's', 'I': 's', 'D': 's', 'B': 's', 'SS': 'ss', 'Si': 'n', 'Ii': 'n',
             'N': 'i', 'Vi': 'i', 'V': 'v', 'Vs': 's', 'S0': 'v', 'I0': 'v', 'B0': 'v',
             'V0': 'v', 'L': 's', 'Li': 'n', 'E': 's', 'D0': 'v', 'I1': 'i',
             'D1': 'i', 'Dd': 'd', 'Ddd': 'dd', 'Ei': 'si', 'Ed': 'sd', 'Vint': 's',
             'Ev': 's', 'EvI': 'si'}
    for shape in sorted(SHAPES):
        names = groups.get(shape, [])
        argshape = alias.get(shape, shape)
        out.append(f'\nstatic const std::map< string, std::function< {RETURNS[shape]}('
                   f'{params[argshape]}) > > kApi_{shape} = {{')
        for name in names:
            ret = RETURNS[shape]
            body = f'vsp::{name}({call[argshape]})'
            if ret == 'void':
                out.append(f'    {{ "{name}", []( {params[argshape]} ) {{ {body}; }} }},')
            else:
                out.append(f'    {{ "{name}", []( {params[argshape]} ) {{ return {body}; }} }},')
        out.append('};')
    CPP_OUT.write_text('\n'.join(out) + '\n')


def write_py(rows):
    out = [PY_HEAD]
    for shape in sorted(SHAPES):
        types = SHAPES[shape]
        args = ', '.join(f"'{t}'" for t in types)
        inner = '(' + args + (',' if len(types) == 1 else '') + ')'
        out.append(f"    '{shape}': ({inner}, '{RETURNS[shape]}'),")
    out.append('}\n')
    out.append('# name -> shape, sorted for a stable diff')
    out.append('FUNCTIONS = {')
    for name, shape, _ in rows:
        out.append(f"    '{name}': '{shape}',")
    out.append('}')
    out.append('')
    out.append('# name -> per-parameter default: None (required), ("lit", value) or ("name", CONSTANT)')
    out.append('DEFAULTS = {')
    for name, shape, defaults in rows:
        if not any(default_value(d) for d in defaults):
            continue
        rendered = ', '.join(repr(default_value(d)) for d in defaults)
        out.append(f"    '{name}': ({rendered},),")
    out.append('}')
    PY_OUT.write_text('\n'.join(out) + '\n')


def smoke_spec():
    """Every extern function with simple parameter types, for the smoke test.

    Unlike the bridge table this keeps output parameters, overloads and complex
    types, so the smoke run can build correctly typed arguments for every name.
    """
    header = HEADER.read_text()
    header = re.sub(r'/\*.*?\*/', '', header, flags=re.S)
    header = re.sub(r'//[^\n]*', '', header)
    decls = re.findall(r'\bextern\s+([^;]*?)\b([A-Za-z_]\w*)\s*\(([^;]*)\)\s*;', header, re.S)
    spec = {}
    for ret, name, args in decls:
        params = []
        for raw in ([] if args.strip() in ('', 'void') else args.split(',')):
            parts = [p for p in raw.split('=')[0].split() if p]
            if len(parts) < 2:
                continue
            params.append(simple_type(' '.join(parts[:-1])))
        spec.setdefault(name, params)
    return spec


def main():
    rows = parse()
    SMOKE_OUT.write_text(json.dumps(smoke_spec(), indent=1, sort_keys=True) + '\n')
    write_cpp(rows)
    write_py(rows)
    counts = {}
    for _, shape, _ in rows:
        counts[shape] = counts.get(shape, 0) + 1
    print(f'{len(rows)} functions bridged generically')
    for shape in sorted(counts, key=lambda s: -counts[s]):
        print(f'  {shape:4s} {counts[shape]:4d}  {RETURNS[shape]} ({", ".join(SHAPES[shape])})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
