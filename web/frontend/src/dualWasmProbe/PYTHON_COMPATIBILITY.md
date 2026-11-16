# Live Python compatibility inventory

This inventory describes the in-process Python console, not the isolated read/modeling probes or desktop OpenVSP. Importing a module is not a guarantee that every function or its native side effects work. See [README](README.md) for bridge and concurrency limitations. Source filenames refer to `src/python_api/packages` in this repository.

| Upstream package | Current live status | Scope and limitations |
| --- | --- | --- |
| `openvsp` | Browser facade, not original SWIG package | Only functions actually implemented by `python/openvsp_live.py` are provided; no arbitrary native calls, multiple instances, or transparent native `vsp` module. OpenVSP operations execute on the page engine thread. |
| `openvsp.degen_geom_parse`, `openvsp.surface_patches`, `openvsp.utilities` | Original module source, aliased into the live package | Parser/helper paths are individually tested, not a promise that every function works. Analysis/file/instance behavior is restricted. |
| `openvsp.parasite_drag` | Not currently installed | Original import requires `V_UNIT_MACH`; sweeping needs unsupported setters and analysis. The upstream sweep changes the model filename and native ParasiteDrag may write CSV through a separate export path; simply discarding the FileName input is not safe. Plotting and interpolation need additional packages. |
| `degen_geom` | Original source | Imported and exercised by DegenGeom parsing; filesystem/plotting behavior is not generally established. |
| `utilities` | Selected original modules | `files`, `units`, `transformations`, `uberlogging`, `wt_util` are installed with pinned six and NumPy. Files are Pyodide virtual filesystem files, not automatically shared with the model or host. Process runners are not supported. |
| `utilities.atmosphere`, `simple_rotor_calcs` | Original source, SciPy installed on demand | SciPy is a same-origin pinned wheel installed only when a command statically imports a SciPy-backed module. Integer `getRatios` arrays truncate (upstream dtype behaviour), `geomAlt2DensAlt` at 0 m raises (upstream Newton range), the base `Atmosphere` class is abstract, and the Mil-210 tables are limited to the altitudes in `atmosphere.py`; these are characterised in `scripts/test-native-atmosphere.py`, not patched. |
| `vsp_airfoils` | Not currently installed | Top-level Matplotlib dependency and file operations need separate browser packaging and verification. |
| `AvlPy`, `CHARM`, `pyPMARC` | Not currently installed | Depend on additional libraries, external executables and/or filesystem workflows; no claim of browser solver support. |
| `PyVSP` | Not supported | Desktop wxPython/VTK UI is not the WebVSP interface. |
| `openvsp_config` and generated facade/SWIG extension | Not native-compatible | Native facade uses processes/TCP and the extension depends on CPython ABI. A browser adapter cannot be called an equivalent desktop runtime. |

The pinned Pyodide assets and vendored NumPy/six/SciPy are served same-origin. `scripts/check-native-modules.mjs` verifies that included upstream source copies match the repository at build time. Test evidence is narrower than complete package compatibility; no missing or untested method should be assumed to work.
