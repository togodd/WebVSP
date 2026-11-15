#!/usr/bin/env python3
"""Generate a textual API declaration inventory; no compiler or bindings required."""
from __future__ import annotations

import argparse
import ast
from collections import defaultdict
import json
import posixpath
from pathlib import Path
import re
import sys
import tokenize

ROOT = Path(__file__).resolve().parents[3]
HEADER = Path('src/geom_api/VSP_Geom_API.h')
PACKAGES = Path('src/python_api/packages')
SYNC = Path('web/frontend/src/dualWasmProbe/sync-api.json')
JSON_OUT = Path('web/frontend/src/dualWasmProbe/NATIVE_API_INVENTORY.json')
MD_OUT = Path('web/frontend/src/dualWasmProbe/NATIVE_API_INVENTORY.md')


def mask_cpp(source):
    """Blank comments and literals, preserving positions/newlines, and return comment spans."""
    chars = list(source)
    comments = []
    i = 0
    while i < len(source):
        start = i
        if source.startswith('//', i):
            end = source.find('\n', i)
            i = len(source) if end < 0 else end
            comments.append((start, i, source[start:i]))
        elif source.startswith('/*', i):
            end = source.find('*/', i + 2)
            if end < 0:
                raise ValueError('unterminated C++ comment')
            i = end + 2
            comments.append((start, i, source[start:i]))
        elif source.startswith('R"', i):
            delim_end = source.find('(', i + 2)
            if delim_end < 0:
                raise ValueError('invalid C++ raw string')
            end = source.find(')' + source[i + 2:delim_end] + '"', delim_end + 1)
            if end < 0:
                raise ValueError('unterminated C++ raw string')
            i = end + len(source[start + 2:delim_end]) + 2
        elif source[i] in "\"'":
            quote = source[i]
            i += 1
            while i < len(source) and source[i] != quote:
                i += 2 if source[i] == '\\' else 1
            if i >= len(source):
                raise ValueError('unterminated C++ literal')
            i += 1
        else:
            i += 1
            continue
        for j in range(start, i):
            if chars[j] != '\n':
                chars[j] = ' '
    return ''.join(chars), comments


def parse_header(source):
    masked, comments = mask_cpp(source)
    records = []
    for match in re.finditer(r'\bextern\b', masked):
        start = match.start()
        depth = 0
        end = None
        for pos in range(match.end(), len(masked)):
            char = masked[pos]
            if char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
                if depth < 0:
                    raise ValueError(f'unbalanced extern at line {source.count(chr(10), 0, start) + 1}')
            elif char == ';' and depth == 0:
                end = pos + 1
                break
            elif char in '{}' and depth == 0:
                raise ValueError(f'unsupported extern at line {source.count(chr(10), 0, start) + 1}')
        if end is None:
            raise ValueError(f'unterminated extern at line {source.count(chr(10), 0, start) + 1}')
        declaration = masked[start:end]
        name = re.search(r'\b([A-Za-z_]\w*)\s*\(', declaration)
        if not name:
            raise ValueError(f'not a supported function declaration at line {source.count(chr(10), 0, start) + 1}')
        # Only immediately preceding comment blocks, with whitespace between, are associated.
        cursor = start
        relevant = []
        for cstart, cend, text in reversed(comments):
            if cend > cursor:
                continue
            if source[cend:cursor].strip():
                break
            relevant.append(text)
            cursor = cstart
        groups = set()
        for text in relevant:
            if text.startswith(('/*!', '/**', '///', '//!')):
                groups.update(re.findall(r'(?<!\w)[\\@]ingroup\s+([A-Za-z_]\w*)', text))
        records.append({'name': name.group(1), 'signature': source[start:end],
                        'line_start': source.count('\n', 0, start) + 1,
                        'line_end': source.count('\n', 0, end - 1) + 1,
                        'doxygen_group': next(iter(groups)) if len(groups) == 1 else None})
    return records


def python_uses(source, path):
    tree = ast.parse(source, filename=path)
    calls = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
    uses = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        base = node.value
        if isinstance(base, ast.Name) and base.id in {'vsp', 'vsp_module', 'openvsp'}:
            receiver = base.id
        elif (isinstance(base, ast.Attribute) and base.attr == 'vsp'
              and isinstance(base.value, ast.Name) and base.value.id == 'self'):
            receiver = 'self.vsp'
        else:
            continue
        uses.append({'name': node.attr, 'receiver': receiver, 'path': path,
                     'line': node.lineno, 'column': node.col_offset + 1,
                     'kind': 'call' if id(node) in calls else 'attribute'})
    return sorted(uses, key=lambda u: (u['path'], u['line'], u['column'], u['name']))


def build_inventory(root):
    declarations = parse_header((root / HEADER).read_text(encoding='utf-8'))
    if not declarations:
        raise ValueError('no declarations found')
    files = sorted((root / PACKAGES).rglob('*.py'))
    if not files:
        raise ValueError('no Python files found')
    uses = []
    for file in files:
        with tokenize.open(file) as f:
            uses.extend(python_uses(f.read(), file.relative_to(root).as_posix()))
    sync = json.loads((root / SYNC).read_text(encoding='utf-8'))
    sync_names = sorted({entry['name'] for entry in sync['apis']})
    by_name = defaultdict(list)
    for declaration in declarations:
        by_name[declaration['name']].append(declaration)
    uses_by_name = defaultdict(list)
    for use in uses:
        uses_by_name[use['name']].append(use)
    names = sorted(by_name)
    name_set = set(names)
    matched_python_names = len(set(uses_by_name) & name_set)
    records = [{'name': name, 'overload_count': len(by_name[name]),
                'declarations': by_name[name], 'python_uses': uses_by_name[name],
                'sync_name_coverage': 'present_limited' if name in sync_names else 'not_listed'}
               for name in names]
    return {'schema_version': 1,
            'scope': {'header': str(HEADER), 'python_root': str(PACKAGES), 'sync_descriptor': str(SYNC),
                      'limitations': 'Textual extern declarations; no preprocessing, compilation, SWIG exposure or runtime compatibility inferred. Python AST receiver spelling only, including tests/examples; aliases, dynamic uses and imports are not resolved. Name matches do not establish overload, behavior or binding compatibility. Doxygen group only from contiguous preceding doc comments with exactly one distinct ingroup.'},
            'counts': {'declarations': len(declarations), 'distinct_names': len(names),
                       'overloaded_names': sum(len(v) > 1 for v in by_name.values()),
                       'python_files': len(files), 'python_receiver_uses': len(uses),
                       'python_names_matching_header': matched_python_names,
                       'sync_distinct_names': len(sync_names), 'sync_names_matching_header': len(set(sync_names) & name_set)},
            'functions': records,
            'python_uses_without_header_name': [u for u in uses if u['name'] not in name_set],
            'sync_names_without_header_name': sorted(set(sync_names) - name_set)}


def markdown(data):
    lines = ['<!-- Generated by web/frontend/scripts/inventory-geom-api.py; do not edit. -->',
             '# Textual VSP geometry API inventory', '', data['scope']['limitations'], '',
             'Regenerate from the repository root with `python3 web/frontend/scripts/inventory-geom-api.py`; verify without writing with `python3 web/frontend/scripts/inventory-geom-api.py --check`. Run tests with `python3 -m unittest discover -s web/frontend/scripts -p "test_inventory_geom_api.py"`.', '',
             'Python files include tests, examples and setup files. Uses include calls and other attribute expressions; column is the 1-based AST UTF-8 byte offset. Names may be helpers, constants or unrelated objects. Header matches are by name only. A missing match is not evidence of unavailability. Conditional C++ branches are all textual; group null means absent or ambiguous. Signatures preserve source text from `extern` through `;`.', '',
             '## Sources', '',
             '- Header: [`VSP_Geom_API.h`](../../../../src/geom_api/VSP_Geom_API.h)',
             '- Python package tree: [`src/python_api/packages`](../../../../src/python_api/packages)',
             '- Limited sync descriptor: [`sync-api.json`](sync-api.json)', '',
             '## Counts', '']
    lines.extend(f'- {key.replace("_", " ")}: **{value}**' for key, value in data['counts'].items())
    lines += ['', '## Declarations grouped by name', '', 'Each name has its declaration(s), group and Python use sites. `present_limited` only means its name appears in the experimental sync descriptor; consult that descriptor for actual restrictions, not overload or compatibility coverage.', '']
    def use_link(use):
        target = posixpath.relpath(use['path'], MD_OUT.parent.as_posix())
        return f"[`{use['path']}:{use['line']}:{use['column']}`]({target}#L{use['line']}) ({use['receiver']}, {use['kind']})"

    for function in data['functions']:
        lines += [f"### `{function['name']}`", '', f"Overloads: {function['overload_count']}; sync name coverage: **{function['sync_name_coverage']}**.", '']
        for decl in function['declarations']:
            location = f"[Header lines {decl['line_start']}–{decl['line_end']}](../../../../src/geom_api/VSP_Geom_API.h#L{decl['line_start']}-L{decl['line_end']})"
            group = f"`{decl['doxygen_group']}`" if decl['doxygen_group'] else 'unknown'
            lines += [f'- {location}; Doxygen group: {group}', '', '```cpp', decl['signature'], '```']
        if function['python_uses']:
            lines += ['', 'Python uses: ' + ', '.join(use_link(u) for u in function['python_uses']) + '.']
        lines.append('')
    lines += ['## Python receiver uses without a header name match', '', 'These are retained rather than assumed to be native functions.', '']
    for use in data['python_uses_without_header_name']:
        lines.append(f"- `{use['name']}` — {use_link(use)}")
    lines += ['', '## Sync descriptor names absent from header', '', ', '.join(f'`{n}`' for n in data['sync_names_without_header_name']) or 'None.', '']
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if either generated report differs; never write')
    args = parser.parse_args(argv)
    inventory = build_inventory(ROOT)
    outputs = {JSON_OUT: json.dumps(inventory, indent=2, ensure_ascii=False) + '\n', MD_OUT: markdown(inventory)}
    stale = []
    for relative, content in outputs.items():
        path = ROOT / relative
        if args.check:
            if not path.is_file() or path.read_bytes() != content.encode('utf-8'):
                stale.append(str(relative))
        else:
            path.write_text(content, encoding='utf-8', newline='\n')
    if stale:
        print('Stale or missing generated reports: ' + ', '.join(stale), file=sys.stderr)
        return 1
    print('Inventory reports ' + ('match' if args.check else 'generated'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
