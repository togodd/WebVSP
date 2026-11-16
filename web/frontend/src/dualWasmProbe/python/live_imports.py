"""Expose the bundled upstream packages under their desktop import names.

The worker installs files in the same relative layout as
``src/python_api/packages``: ``openvsp/`` (the facade plus the three upstream
helper modules), ``degen_geom/`` and ``utilities/``. Scripts written for the
desktop module import ``openvsp`` and its submodules; older WebVSP scripts used
flat module names, so those names are aliased to the *same* module objects
rather than executing a source file twice.
"""
import importlib
import sys

_openvsp = importlib.import_module('openvsp')

# Upstream imports `degen_geom` by its absolute name from openvsp helpers, so the
# package is imported first and stays at the top level as well.
importlib.import_module('degen_geom')
importlib.import_module('degen_geom.degen_geom')

# Canonical package module -> historical flat module name.
for _canonical, _legacy in (
    ('openvsp.surface_patches', 'surface_patches'),
    ('openvsp.degen_geom_parse', 'degen_geom_parse'),
    ('openvsp.utilities', 'openvsp_utilities'),
):
    _module = importlib.import_module(_canonical)
    sys.modules[_legacy] = _module
    setattr(_openvsp, _canonical.split('.')[-1], _module)

# Export reviewed desktop entry points without replacing the live facade's
# optimized parse_results_object or copying incidental imports from upstream.
for _source, _names in (
    ('openvsp.surface_patches', ('SurfaceComponent', 'Surface', 'SurfacePatch', 'export_surface_patches')),
    ('openvsp.degen_geom_parse', ('parse_degen_geom',)),
    ('openvsp.utilities', ('get_wing_reference_quantities',)),
):
    _module = importlib.import_module(_source)
    for _name in _names:
        if hasattr(_openvsp, _name):
            raise RuntimeError('Live facade export collision: ' + _name)
        setattr(_openvsp, _name, getattr(_module, _name))

del _canonical, _legacy, _module, _name, _names, _openvsp, _source
