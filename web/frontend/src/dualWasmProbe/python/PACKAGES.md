# 上游 Python 包镜像

本目录按 `src/python_api/packages` 的原始相对路径存放随浏览器分发的上游文件，因此“目录里有什么”就等于“浏览器控制台随包提供了什么”。

- 每个文件与上游**逐字节一致**，`scripts/check-native-modules.mjs` 在 `dev`/`build` 前按相同相对路径校验。
- 没有出现的文件就是**未提供**的，原因见 [兼容性清单](../PYTHON_COMPATIBILITY.md)。
- 少数 WebVSP 自己编写的文件不在这个镜像里：`../openvsp_live.py`（`openvsp` 门面）、`../live_imports.py`（导入别名）。

## 与上游的对应关系

| 上游包 | 已镜像的文件 | 未提供（举例） |
| --- | --- | --- |
| `openvsp/openvsp/` | `utilities.py`、`degen_geom_parse.py`、`surface_patches.py` | `__init__.py`（由 WebVSP 门面代替）、`conf.py`、`parasite_drag.py`、`tests/` |
| `degen_geom/degen_geom/` | `__init__.py`、`degen_geom.py` | 无（绘图方法依赖 matplotlib，运行到才失败） |
| `utilities/utilities/` | `__init__.py`、`files.py`、`units.py`、`transformations.py`、`uberlogging.py`、`wt_util.py`、`atmosphere.py`、`simple_rotor_calcs.py` | `plots.py`、`runners.py` |
| `vsp_airfoils/vsp_airfoils/` | —— | 全部（需要 matplotlib 与文件读写） |
| `AvlPy/`、`CHARM/`、`pyPMARC/` | —— | 全部（外部求解器与重依赖） |
| `PyVSP/pyvsp/` | —— | 全部（wxPython/VTK 桌面界面） |
| `openvsp_config/` | —— | 全部（原生加载配置） |

## 运行时如何安装

`syncWorker.ts` 把镜像复制到 Pyodide 的 `/sync-live`：`openvsp/` 下写入门面 `__init__.py` 与三个上游文件，`degen_geom/`、`utilities/` 原样复制；随后执行 `live_imports.py`，把 `openvsp.surface_patches` 等规范路径与历史顶层名指向**同一个模块对象**，并导出桌面版 `openvsp` 包顶层的 `export_surface_patches`、`parse_degen_geom`、`get_wing_reference_quantities`。
