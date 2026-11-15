"""Static inventory of src/python_api/packages for browser reuse triage."""
from __future__ import annotations

import ast
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / "src/python_api/packages"
OUT = Path(__file__).resolve().parents[1] / "src/dualWasmProbe/PYTHON_PACKAGE_AUDIT.md"

STDLIB = sys.stdlib_module_names
LOCAL = {"avlpy", "charm", "pyvsp", "degen_geom", "openvsp", "openvsp_config", "pypmarc", "utilities", "vsp_airfoils"}
GUI_NAMES = {"tkinter", "matplotlib", "wx", "vtk", "PyQt5", "PySide6"}
PROCESS_NAMES = {"subprocess", "Popen", "PIPE", "STDOUT", "multiprocessing", "pathos"}


def root_name(name: str) -> str:
    return name.split(".", 1)[0]


def module_package(path: Path) -> str:
    rel = path.relative_to(ROOT)
    return rel.parts[0] if rel.parts else "unknown"


def collect(path: Path) -> dict:
    source = path.read_text()
    tree = ast.parse(source, filename=str(path))
    imports: set[str] = set()
    openvsp_symbols: set[str] = set()
    calls: set[str] = set()
    functions: list[str] = []
    classes: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(root_name(alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.add(root_name(node.module))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node.name)
        elif isinstance(node, ast.ClassDef):
            classes.append(node.name)
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                calls.add(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                calls.add(node.func.attr)
                base = node.func.value
                if isinstance(base, ast.Name) and base.id in {"vsp", "vsp_module", "openvsp"}:
                    openvsp_symbols.add(node.func.attr)
                elif isinstance(base, ast.Attribute) and base.attr in {"vsp", "vsp_module", "openvsp"}:
                    openvsp_symbols.add(node.func.attr)
        elif isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id in {"vsp", "vsp_module", "openvsp"}:
                openvsp_symbols.add(node.attr)
            elif isinstance(node.value, ast.Attribute) and node.value.attr in {"vsp", "vsp_module", "openvsp"}:
                openvsp_symbols.add(node.attr)
    local_imports = sorted(i for i in imports if i in LOCAL)
    third = sorted(i for i in imports if i not in STDLIB and i not in LOCAL)
    flags = set()
    if "openvsp" in imports or openvsp_symbols:
        flags.add("OpenVSP API")
    if imports & PROCESS_NAMES or calls & PROCESS_NAMES:
        flags.add("process/runner")
    if imports & {"os", "pathlib", "glob", "shutil", "tempfile"} or calls & {"open", "glob"}:
        flags.add("filesystem/path")
    if imports & GUI_NAMES:
        flags.add("GUI/plot")
    if third:
        flags.add("third-party dependency")
    if local_imports:
        flags.add("package-local")
    if not flags:
        tier = "A0 — pure Python"
    elif flags <= {"third-party dependency", "package-local"}:
        tier = "A1 — package/dependency; unknown portability"
    elif "OpenVSP API" in flags and not (flags & {"process/runner", "filesystem/path", "GUI/plot"}):
        tier = "B — OpenVSP model API"
    elif "OpenVSP API" in flags:
        tier = "C — mixed OpenVSP/environment"
    else:
        tier = "D — external environment"
    return {
        "package": module_package(path),
        "path": str(path.relative_to(ROOT)),
        "lines": len(source.splitlines()),
        "functions": functions,
        "classes": classes,
        "imports": sorted(imports),
        "third_party": third,
        "local_imports": local_imports,
        "openvsp_symbols": sorted(openvsp_symbols),
        "flags": sorted(flags),
        "tier": tier,
    }


records = []
for path in sorted(ROOT.rglob("*.py")):
    if any(part in {"test", "tests", "examples"} for part in path.parts):
        continue
    try:
        records.append(collect(path))
    except SyntaxError as exc:
        records.append({"package": module_package(path), "path": str(path.relative_to(ROOT)), "tier": "X — parse failure", "error": str(exc), "lines": len(path.read_text().splitlines())})

by_tier = Counter(r["tier"] for r in records)
by_package = defaultdict(list)
for r in records:
    by_package[r["package"]].append(r)
if not records:
    raise RuntimeError(f"No Python files found at {ROOT}")

facade = {entry['name'] for entry in json.loads((OUT.parent / 'sync-api.json').read_text())['apis']}
uses = Counter(symbol for r in records for symbol in r.get('openvsp_symbols', []))
metadata = {}
for path in sorted(ROOT.glob('*/setup.py')):
    tree = ast.parse(path.read_text(), filename=str(path))
    values = []
    for node in ast.walk(tree):
        candidate = None
        if isinstance(node, ast.keyword) and node.arg == 'install_requires':
            candidate = node.value
        elif isinstance(node, ast.Dict):
            candidate = next((value for key, value in zip(node.keys, node.values) if isinstance(key, ast.Constant) and key.value == 'install_requires'), None)
        if candidate is not None:
            try:
                value = ast.literal_eval(candidate)
                values.extend(value if isinstance(value, (list, tuple)) else [str(value)])
            except (ValueError, TypeError):
                values.append('[nonliteral]')
    metadata[str(path.relative_to(ROOT))] = values

lines = [
    "# Python package reuse audit",
    "",
    "This is a static inventory of `src/python_api/packages`, generated with the host Python stdlib module list. It excludes test and example files and non-`.py` files (including `openvsp/setup.py.in`) from module counts. A tier is a triage signal, not proof of browser compatibility; sampled runtime evidence is recorded separately below.",
    "",
    "## Scope and tier definitions",
    "",
    "- **A0 — pure Python**: standard-library-only code with no OpenVSP, process, filesystem, or GUI dependency.",
    "- **A1 — package/dependency; unknown portability**: no OpenVSP/environment dependency, but imports a non-stdlib package or local package; runtime package availability and numerical parity must be tested.",
    "- **B — OpenVSP model API**: primarily synchronous `openvsp` calls; potentially reusable after facade coverage and return-type checks.",
    "- **C — mixed OpenVSP/environment**: OpenVSP plus files, subprocesses, plotting, or other desktop/runtime dependencies.",
    "- **D — environment indicators**: no directly detected OpenVSP receiver but has file/path, process, or GUI indicators; importing os alone is a conservative indicator, not proof of incompatibility.",
    "",
    "Only syntactic indicators are used: imports anywhere (including lazy/conditional), calls and attributes on receivers named vsp, vsp_module, openvsp or .vsp. It does not resolve aliases, wildcards, dynamic dispatch, transitive imports, constants imported directly, or argument overloads; local packages can hide environment dependencies. Counts include setup and __init__ files, nested functions and methods. A module tier is not a function tier, importability verdict, or reuse percentage. Possible false positives and negatives require manual review.",
    "",
    "## Static totals",
    "",
    f"- Python modules scanned: **{len(records)}**",
    f"- Functions and methods (AST definitions): **{sum(len(r.get('functions', [])) for r in records)}**",
    f"- Classes: **{sum(len(r.get('classes', [])) for r in records)}**",
    f"- Tiers: **{dict(sorted(by_tier.items()))}**",
    "",
    "## Module inventory",
    "",
    "| Tier | Package | Module | Lines | Functions | Classes | OpenVSP symbols | Other flags / external imports |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | --- |",
]
for r in records:
    if "error" in r:
        lines.append(f"| {r['tier']} | {r['package']} | `{r['path']}` | {r['lines']} | — | — | — | {r['error']} |")
        continue
    symbols = ", ".join(f"`{x}`" for x in r["openvsp_symbols"]) or "—"
    flags = ", ".join(r["flags"]) or "—"
    deps = ", ".join(r['third_party']) or '—'
    lines.append(f"| {r['tier']} | {r['package']} | `{r['path']}` | {r['lines']} | {len(r['functions'])} | {len(r['classes'])} | {symbols} | {flags}; external: {deps} |")

lines += [
    "",
    "## Package metadata (distribution names)",
    "",
    "The following values come from `setup.py install_requires`; distribution names are intentionally not treated as import names. Conditional imports and transitive dependencies still require runtime review.",
    "",
]
for setup_path, requirements in sorted(metadata.items()):
    lines.append(f"- `{setup_path}`: {', '.join(requirements) if requirements else '(none)'}")
lines += [
    "",
    "## Package-level interpretation",
    "",
]
for package, modules in sorted(by_package.items()):
    tiers = Counter(m["tier"] for m in modules)
    openvsp = sorted({s for m in modules for s in m.get("openvsp_symbols", [])})
    lines.append(f"- **{package}**: {len(modules)} modules; {dict(tiers)}; OpenVSP symbols: {', '.join(openvsp) if openvsp else 'none'}.")

lines += [
    "",
    "## Detected receiver symbols versus experimental facade",
    "",
    "Module counts indicate syntactic occurrences in distinct scanned modules, not calls, importance, or a compatibility percentage. This list may include helpers and constants, and may miss names. Presence in the facade is not semantic or overload compatibility.",
    "",
    "| Symbol | Modules | In reviewed facade by name? |",
    "| --- | ---: | --- |",
]
for symbol, count in sorted(uses.items(), key=lambda x: (-x[1], x[0])):
    lines.append(f"| `{symbol}` | {count} | {'yes (scope limited)' if symbol in facade else 'no / helper / constant'} |")
lines += [
    "",
    "## Runtime evidence and limitations",
    "",
    "See [PYTHON_PACKAGE_SAMPLING.md](PYTHON_PACKAGE_SAMPLING.md) for actual executed cases and test setup. A module tier is not proof of browser compatibility. The original OpenVSP utility module is loaded under an alternate name with the restricted facade and an explicit SET_ALL import shim, not as the native package.",
    "",
]
OUT.write_text("\n".join(lines) + "\n")
print(f"Wrote {OUT}")
print(f"modules={len(records)} functions={sum(len(r.get('functions', [])) for r in records)} tiers={dict(sorted(by_tier.items()))}")
