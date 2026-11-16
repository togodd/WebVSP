"""Expose bundled upstream modules under desktop and historical import names.

Import the original top-level modules first: their upstream sources use absolute
imports and may import the already-initialized openvsp facade. Alias the very
same module objects, including package children, rather than executing a source
file a second time under a different name.
"""
import importlib
import sys

_openvsp = importlib.import_module('openvsp')
for _legacy, _canonical in (
    ('surface_patches', 'surface_patches'),
    ('degen_geom_parse', 'degen_geom_parse'),
    ('openvsp_utilities', 'utilities'),
    ('degen_geom', 'degen_geom'),
    ('degen_geom.degen_geom', 'degen_geom.degen_geom'),
):
    _module = importlib.import_module(_legacy)
    sys.modules['openvsp.' + _canonical] = _module
    if '.' not in _canonical:
        setattr(_openvsp, _canonical, _module)

# Export reviewed desktop entry points without replacing the live facade's
# optimized parse_results_object or copying incidental imports from upstream.
for _source, _names in (
    ('surface_patches', ('SurfaceComponent', 'Surface', 'SurfacePatch', 'export_surface_patches')),
    ('degen_geom_parse', ('parse_degen_geom',)),
    ('openvsp_utilities', ('get_wing_reference_quantities',)),
):
    _module = importlib.import_module(_source)
    for _name in _names:
        if hasattr(_openvsp, _name):
            raise RuntimeError('Live facade export collision: ' + _name)
        setattr(_openvsp, _name, getattr(_module, _name))

del _legacy, _canonical, _module, _openvsp, _source, _names, _name
