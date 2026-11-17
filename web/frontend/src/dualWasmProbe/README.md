# 浏览器内 Python 控制台

本目录只保留一条可在页面上使用的 Python 路径：**Python 控制台（live）**，包括顶栏 **Python Console**
按钮、`window.__runPython` 和脚本模式。Python 运行在持久 Pyodide worker 中，`openvsp` 调用经同步桥交给
页面的 OpenVSP 引擎线程，直接读写**当前页面模型**。

文件 API 通过“Python 工作区”工作：控制台里挂载一个文件夹（或添加文件），页面把内容镜像到引擎文件系统
的 `/work`；Python 的同步文件调用操作引擎路径，磁盘读写、文件选择器和下载仍由页面负责。

原先的隔离分析窗口（顶栏 **Geometry analysis**）及其一次性 WASM/Pyodide 分析链、早期用于验证桥接的固定
诊断均已删除；它们的结论压缩在文末“历史结论”中。

```python
import openvsp as vsp
import surface_patches

w = vsp.AddGeom('WING')
vsp.SetParmVal(w, 'TotalSpan', 'WingGeom', 12.0)
vsp.Update()
comps = surface_patches.export_surface_patches(vsp.SET_ALL)
[(c.name, len(c.surfaces), sum(len(s.patches) for s in c.surfaces)) for c in comps]
```

## 目录与上游镜像

`python/packages/` 与 `src/python_api/packages` 使用**相同的相对路径**，只放实际随页面分发的上游文件；
每个文件与上游逐字节一致，`npm run dev` / `npm run build` 前由 `scripts/check-native-modules.mjs` 校验。

```
python/packages/openvsp/openvsp/{utilities,degen_geom_parse,surface_patches}.py
python/packages/degen_geom/degen_geom/{__init__,degen_geom}.py
python/packages/utilities/utilities/{__init__,files,units,transformations,uberlogging,wt_util,atmosphere,simple_rotor_calcs}.py
```

目录里没有的文件就是浏览器里没有提供的文件，可以直接对比：

```bash
diff -rq -x '__pycache__' src/python_api/packages web/frontend/src/dualWasmProbe/python/packages
```

| 上游包 | 已提供 | 未提供（原因见下文“未打包的模块”） |
| --- | --- | --- |
| `openvsp/openvsp/` | `utilities.py`、`degen_geom_parse.py`、`surface_patches.py` | `__init__.py`（由 WebVSP 门面代替）、`conf.py`、`parasite_drag.py`、`tests/` |
| `degen_geom/degen_geom/` | `__init__.py`、`degen_geom.py` | 无（绘图方法依赖 matplotlib，调用时才失败） |
| `utilities/utilities/` | `__init__.py`、`files.py`、`units.py`、`transformations.py`、`uberlogging.py`、`wt_util.py`、`atmosphere.py`、`simple_rotor_calcs.py` | `plots.py`、`runners.py` |
| `vsp_airfoils/`、`AvlPy/`、`CHARM/`、`pyPMARC/`、`PyVSP/`、`openvsp_config/` | —— | 全部，原因见下表 |

WebVSP 自己编写的 Python 文件在 `python/` 顶层：`openvsp_live.py`（门面）、`live_imports.py`（导入别名）。

## 运行机制与限制

- 包安装到 Pyodide 的 `/sync-live`：`openvsp/__init__.py` 是门面，`openvsp/` 下另有三个原始助手，
  `degen_geom/`、`utilities/` 按上游布局复制。`live_imports.py` 把 `openvsp.surface_patches` 等规范路径
  与历史顶层名（`surface_patches`、`degen_geom_parse`、`openvsp_utilities`）指向**同一个模块对象**，并导出
  桌面版 `openvsp` 包顶层的 `export_surface_patches`、`parse_degen_geom`、`get_wing_reference_quantities`；
  门面自己的优化版 `parse_results_object` 不会被覆盖，解析缓存只在一次解析内有效。
- 所有 OpenVSP 调用都在引擎 pthread 上执行；Python 线程用 `SharedArrayBuffer` + `Atomics.wait` 同步等待，
  最长 60 秒。写入的 `OpenVSPError.outcome` 为 `not_written`（派发前被拒）或 `unknown`（可能已执行）；
  超时**不会取消**已派发的引擎工作，不要自动重试。
- 分析执行期间引擎线程被占用，GUI 镜像与 3D 视图停止刷新，也没有取消机制；分析 OOM 或断言会连同未保存的
  修改一起结束整个页面会话。这是你本人页面里的任意 Python，不是安全沙箱。
- 可执行的分析白名单为 `DegenGeom`、`SurfacePatches`、`MassProp` 和 `CompGeom`；`ListAnalysis()` 列出的是
  引擎知道的全部分析，不代表全部可执行。`SetIntAnalysisInput` 只接受单个整数、`index=0`，并校验输入类型。
  前两种分析强制全模型；后两种尊重调用方的集合。执行策略会禁用 mode 和相关文件输出，分析结果留在 ResultsManager。
- 数值字段用有界二进制分块，保留 IEEE NaN/±Inf 与不规则矩阵；字符串按最多 4096 UTF-8 字节分块，支持超过
  响应缓冲区的单个字符串。同一字段可能在不同分块之间变化，形状变化能被发现，但同形状并发修改不是原子快照。
- `parse_results_object` 先取单对象有界快照（≤512 KiB、32,768 items、1,024 字段），不支持或超限时退回逐字段
  读取。`GetResultSnapshots([id, ...])` 是显式 ID、单引擎任务内的批量接口（≤32 个 ASCII ID、每个 ≤128 字节、
  总计 ≤512 KiB），保留顺序与重复项，逐项返回 `ok`/`unknown`/`over_limit_or_unsupported`；只保证同一引擎任务
  内一致，不承诺跨请求一致。递归结果树路径（`GetResultTree` 等）因无法证明有界且无损，被固定拒绝。
- SciPy 按需安装：`utilities.atmosphere` 与 `utilities.simple_rotor_calcs` 需要它。命令执行前静态扫描
  `import`/`from ... import`，命中才从同源安装（校验 `scipy → numpy` 依赖闭包），扫描不执行用户代码；动态导入
  无法扫描，会提示并在后台安装，重跑即可。本机实测：安装约 1.1 秒，首次 `import scipy` 约 1.5 秒，不使用
  SciPy 的命令不承担这些开销。

## 与桌面 Python API 的对照与路线

对照范围是下方现有清单，而非全部上游 API。桌面包的入口从 SWIG 生成的 `vsp` 导入原生接口，再导入 Python
helper（[上游入口](../../../../src/python_api/packages/openvsp/openvsp/__init__.py)、[构建定义](../../../../src/python_api/CMakeLists.txt)）；浏览器使用
[门面](python/openvsp_live.py) 和[引擎操作](../../../wasm/engine/engine.cpp)。同名不意味着重载、错误或副作用完全相同。

| 类别 | 代表接口及证据边界 |
| --- | --- |
| 原生函数形状 | `AddGeom`、`SetParmVal`、`GetNumXSec`、`ExecAnalysis`、`GetNumData` 可与[原生声明](../../../../src/geom_api/VSP_Geom_API.h)对照；门面只桥接其中一部分，例如 `SetParmVal` 支持按 ID 和按名称两种原生重载。测试范围逐项见下表，不等于桌面语义全面一致。 |
| 浏览器扩展 | `GetParmInfo`/`GetParmInfoByName`、`GetParmValByID`/`SetParmValByID`、`GetXSecSurfIDs`/`GetXSecIDs`、`GetResultShape`/`GetBinaryResults`、`GetResultSnapshotCapabilities`/`GetResultSnapshots` 是门面提供的便利或诊断接口，不能当作桌面原生同名 API；例如原生截面列表使用 `GetXSecSurfIDVec`。批量快照有明确大小和一致性边界，见上文。 |
| 明确不支持或受限 | `SetDoubleAnalysisInput`、`SetStringAnalysisInput` 未桥接；`ExecAnalysis` 仅开放四种分析，`ListAnalysis` 并非可执行清单。文件 API 使用引擎虚拟文件系统，`WriteVSPFile` 只接受 `SET_ALL`，导入父几何及 STEP 导出不支持；超时不取消任务。递归结果树接口主动拒绝。细节见下方清单和文件 API。 |
| 未验证 | 已桥接但未单独测试的截面、子表面及集合接口，以及 `get_wing_reference_quantities`、`get_propeller_thrust_vectors` 等 helper，不能由源码存在或依赖已测推断为可用。主机测试可能使用模拟桥；真实浏览器脚本的证据仅覆盖各自场景，见[几何测试](../../scripts/test-live-geometry.py)及文末测试表。 |

**路线（按风险递进）**：先为已有但未单测接口补主机参数/错误测试与真实浏览器模型测试，对照桌面返回值、
重载和副作用；再按脚本需求补低副作用的原生查询与参数重载，逐项实现门面、桥和引擎并验证。分析与文件能力
须先约定输入、输出、工作区和副作用，再逐项做桌面对照及超时/失败测试；涉及外部进程、取消或长任务的能力
须另设计异步生命周期，不因 `ListAnalysis` 可发现就开放。每一步仅把实际测试的场景标为已验证，不给出覆盖率。

## 兼容性清单

标记：**✅** 已实现且有相关自动测试（只覆盖所测场景）；**🟨** 已实现但未单独测试；**🚫** 存在但被桥接层禁用；**❌** 未实现或所需依赖未打包。测试命令见文末；不同测试的主机模拟与浏览器证据不可互换。

### `openvsp` 门面（`python/openvsp_live.py`）

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `OpenVSPError`、`get_instance()` | ✅ | 错误带 `outcome`/`actual`/`code`；只接受本模块，第二实例直接 `ValueError` |
| `SET_ALL`、数据类型常量、`CLONE_DELETE_*` | ✅ | `SET_ALL=0` 构建时与 `APIDefines.h` 校验 |
| `XS_*`、`SS_*` 常量 | ✅ | 覆盖原生 `XSEC_CRV_TYPE`、`SUBSURF_TYPE`；构建前对照 `APIDefines.h`，计数哨兵不是可创建的类型 |
| `AddGeom`、`DeleteGeom`、`Update`、`FindGeoms`、`FindGeom` | ✅ | `DeleteGeom` 支持三种克隆策略；`Update` 参数被忽略，始终完整更新 |
| `FindGeoms`、`FindGeom`、`GetGeomName`、`GetGeomTypeName` | ✅ | 直接读引擎线程，改名后同一段脚本内即可见 |
| `GetGeomParent`、`GetGeomChildren`、`SetGeomName` | ✅ | 顶层父级是 `'NONE'`；自命名（Clone 等）拒绝改名 |
| `GetGeomTypes`、`GetNumMainSurfs`、`UpdateGeom`、`SetGeomParent`、`CopyGeomToClipboard`、`CutGeomToClipboard`、`PasteGeomClipboard` | ✅ | 已通过真实浏览器几何更新、父子关系和剪贴板回归 |
| `GetGeomParmIDs` | ✅ | |
| `CompPnt01`、`CompNorm01` | ✅ | 已通过机身与机翼真实浏览器回归，返回支持 `x()`/`y()`/`z()` 的 vec3d |
| `GetParmVal`、`SetParmVal` | ✅ | `GetParmVal` 支持单参数重载；`SetParmVal` 支持两参数和四参数重载，均不触发更新 |
| `GetParmInfo`、`GetParmInfoByName`、`GetParmValByID`、`SetParmValByID` | ✅ | `GetParmInfo` 另含 `active`、`lower`、`upper`、`groupName` |
| `GetParmType`、`GetParmLowerLimit`/`UpperLimit`、`GetParmActiveFlag` | ✅ | 限制为 `None` 表示无界 |
| `FindParm`、`GetParmName`、`GetParmGroupName`、`GetParmDisplayGroupName` | ✅ | `FindParm`/`GetParmVal` 用内部组名；显示组名见 `GetParmDisplayGroupName` |
| `SetParmValUpdate`（两个重载） | ✅ | 触发模型更新；不做 limits/active 预检（原生语义） |
| `GetNumXSecSurfs`、`GetXSecSurf`、`GetXSec`、`GetXSecParmIDs`、`DeleteXSec`、`ChangeXSecShape(ByID)` | 🟨 | 已桥接，未单独测试 |
| `GetXSecSurfIDs`、`GetNumXSec`、`GetXSecIDs`、`GetXSecShape`、`InsertXSec`、`CutXSec` | ✅ | 真实浏览器已验证典型插入/删除/形状查询路径 |
| `GetXSecIDVec`、`InsertXSecByID`、`CutXSecByID` | ✅ | 已通过真实浏览器/WASM 插入与删除回归 |
| `GetXSecSurfIDVec`、`GetXSecParm`、`GetXSecWidth`/`Height`、`SetXSecWidth`/`Height`/`WidthHeight` | ✅ | 截面尺寸及参数查询已通过真实浏览器回归；曲面 ID 列表有主机桥接测试 |
| `CopyXSec`、`CopyXSecByID`、`PasteXSec`、`PasteXSecByID` | ✅ | 真实浏览器验证剪贴板快照及目标替换 |
| `GetXSecAlias`、`SetXSecAlias`、`GetXSecCurveAlias`、`SetXSecCurveAlias` | ✅ | 真实浏览器验证读写与恢复 |
| `GetXSecContinuity`、`SetXSecContinuity`、`GetXSecTanAngles`/`Slews`/`Strengths`、`GetXSecCurvatures` 及对应 setter | 🟨 | 只作用于原生 `SkinXSec`（自定义几何截面）；本版机翼截面是 `XSecCurve`，原生直接报错。浏览器已验证该错误路径，成功路径尚未覆盖 |
| `GetNumSubSurf`、`GetSubSurf`、`DeleteSubSurf`、`ReorderSubSurf`、`GetSubSurfType`、`GetSubSurfParmIDs`、`GetSubSurfName`、`SetSubSurfName`、`GetSubSurfIndex` | ✅ | 已通过真实浏览器/WASM 名称、顺序、参数与删除回归 |
| `GetSubSurfIDVec`、`AddSubSurf` | ✅ | |
| `GetNumSets`、`GetSetName`、`GetSetFlag` | ✅ | |
| `GetSetIndex`、`GetGeomSet`、`GetGeomSetAtIndex` | ✅ | 按名/序号读集合成员；`GetSetIndex` 不存在返回 -1 |
| `GetSetNames`、`SetSetName`、`SetSetFlag` | ✅ | 已通过真实浏览器/WASM 集合改名与成员标记回归 |
| `ExecAnalysis` | ✅ | 只允许执行 `DegenGeom`/`SurfacePatches`/`MassProp`/`CompGeom`，且部分输入会被限制 |
| `SetAnalysisInputDefaults` | ✅ | 对任意有效分析调用原生初始化，可能产生初始化副作用 |
| `ListAnalysis`、`GetAnalysisInputNames`、`GetAnalysisInputType` | ✅ | 可发现分析和输入；发现不意味着能执行 |
| `GetIntAnalysisInput`、`GetDoubleAnalysisInput`、`GetStringAnalysisInput` | ✅ | 返回完整向量并支持有效索引；真实浏览器验证基础读取 |
| `SetIntAnalysisInput`、`SetDoubleAnalysisInput`、`SetStringAnalysisInput` | ✅ | 完整向量和合法 index 通过长度前缀帧一次调用；字符串支持空串与任意 Unicode，不支持 NUL；已通过真实浏览器回归 |
| `GetAllResultsIDs`、`GetAllResultsNames`、`GetAllDataNames`、`GetResultsName`、`GetResultsType` | ✅ | |
| `FindResultsID(name, index=0)`、`FindLatestResultsID(name)`、`GetNumResults(name)` | ✅ | 不存在时返回 `''`/`0`，不抛异常 |
| `DeleteResult(id)`、`DeleteAllResults()` | ✅ | 未知 ID 视为空操作；长会话可用它们控制 ResultsMgr 增长 |
| `GetNumData`、`GetResultShape`、`GetBinaryResults` | 🟨 | 后两者是诊断用、非桌面上游接口 |
| `GetIntResults`/`GetDoubleResults`/`GetStringResults`/`GetDoubleMatResults`/`GetVec3dResults` | ✅ | `Vec3d` 提供 `x()/y()/z()`，`repr` 形如 `vec3d(1.0, 2.0, 3.0)` |
| `parse_results_object`、`GetResultSnapshotCapabilities`、`GetResultSnapshots` | ✅ | 见“运行机制与限制” |
| `GetResultTree`、`parse_results_tree`、`parse_results_object_fast`、`parse_surface_patches_fast` | 🚫 | 递归结果树被固定拒绝 |
| `ReadVSPFile`、`WriteVSPFile`、`ExportFile`、`ImportFile`、`SetVSP3FileName`、`GetVSPFileName`、`ClearVSPModel` | ✅ | 同步语义，操作引擎文件系统；相对路径解析到 `/work`（见“Python 工作区与文件 API”）。`ExportFile` 只支持原生默认可选参数；本构建无 STEP 导出 |

### 上游 helper 模块

导入方式：`openvsp.<name>` 与历史顶层名是**同一模块对象**，不是副本。

| 模块 / 函数 | 状态 | 说明 |
| --- | --- | --- |
| `surface_patches.export_surface_patches`、`SurfaceComponent/Surface/SurfacePatch` | ✅ | 原样源码，真实浏览器验证 |
| `surface_patches.plot_surface_components` | ❌ | 需要 matplotlib |
| `degen_geom_parse.parse_degen_geom` | ✅ | 原样源码，真实浏览器验证 |
| `degen_geom` 数据类 | ✅ | 解析结果即这些对象；`DegenGeomMgr` 🟨 未单独测试 |
| `degen_geom` 的 `plot_copies`、`plot_copies_plates` | ❌ | 延迟导入 matplotlib |
| `openvsp_utilities.parse_results_object` | ✅ | 门面优化版覆盖同名函数，上游实现仍被调用 |
| `convert_vec3d_array_to_list_matrix`、`convert_double_tuple_to_list_matrix` | ✅ | 纯转换 |
| `get_wing_reference_quantities` | 🟨 | 依赖的 `FindGeom`/`GetParmVal` 已测；函数本身未在控制台单独运行 |
| `get_propeller_thrust_vectors`、`get_single_propeller_info` | 🟨 | 需要含 Prop 的 DegenGeom，未在浏览器专门验证 |
| `plot_propeller_info`、`set_3d_axis_equal` | ❌ | 需要 matplotlib |
| `run_degen_geom`、`genX3d`、`export_airfoils` | 🟨 | 部分依赖的文件/集合 API 已桥接，但上游 helper 的文件系统和其余依赖尚未完整验证，不能视为可用 |

### `utilities` 包

`utilities/__init__.py` 只导出 `files`；其余模块要显式 `import utilities.<name>`。

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| `units.py` | ✅ | 纯 `math`；`tas2eas`/`eas2tas` 需要大气对象（SciPy） |
| `transformations.py` | ✅ | 纯 NumPy；`TransMatrix` 由解析路径与导入测试覆盖 |
| `files.py` | 🟨 | `split_filename`、`AsciiFile`、`BinaryFile`、`StructUnpack` 可用（仅虚拟 FS）。`RunManager` 传 `copyfiles` 时因上游使用 Python ≥3.10 已移除的 `collections.Iterable` 报 `AttributeError`（上游缺陷，未修改） |
| `uberlogging.py` | ✅ | 原样源码，`%`/`{}`/默认风格均有测试 |
| `wt_util.py` | ✅ | `find_nearest`、`merge_files`、`archive*`、`remove_file(s)` 已测；`keyboard()` 需要交互，文件操作仅虚拟 FS |
| `atmosphere.py` | ✅ | SciPy 按需。已知上游行为：整数数组输入截断比值、0 m 密度高度求根越界、基类抽象 |
| `simple_rotor_calcs.py` | ✅ | `ct` 与定义一致；其余纯数值函数 🟨 未逐个测试 |
| `plots.py`、`runners.py` | ❌ | 需要 matplotlib/pandas，或 `multiprocessing_logging` 与进程 |

### 未打包的模块及原因

| 模块 | 原因 |
| --- | --- |
| `openvsp.parasite_drag` | 导入即求值 `V_UNIT_MACH`（门面未定义）；扫掠需要未实现的分析设置；上游会改模型文件名且可能经独立路径写 CSV；绘图/插值还需 matplotlib/scipy |
| `vsp_airfoils` | 顶层 `import matplotlib.pyplot`，且依赖文件读写 |
| `AvlPy` | 需要外部 AVL 进程、pandas、fortranformat |
| `CHARM` | 需要外部求解器/bg2charm、scipy、pandas、opencv、pyautogui 等 |
| `pyPMARC` | 需要外部 PMARC、pydantic、f90nml、matplotlib |
| `PyVSP` | wxPython/VTK 桌面界面，不是 WebVSP 的交互方式 |
| `openvsp_config`、SWIG `_vsp`、`facade` | CPython ABI 扩展与 TCP/子进程 facade，浏览器不可用 |

### 依赖

| 依赖 | 状态 |
| --- | --- |
| NumPy 2.4.6、six 1.17.0 | ✅ 预装，同源 vendored wheel，构建时校验 SHA-256 与 Pyodide lock |
| SciPy 1.18.0 | ✅ 按需安装（约 14 MB） |
| matplotlib、pandas、f90nml、fortranformat、multiprocessing_logging、opencv、wx、VTK | ❌ 未打包 |
| 进程（`subprocess`） | ❌ Pyodide 报 `OSError: emscripten does not support processes` |
| 文件系统 | 🟨 Pyodide 内存 FS，与页面模型/宿主机磁盘不自动互通 |

### 参数元数据

```python
pid = vsp.FindParm(w, 'TotalSpan', 'WingGeom')   # 不存在返回 ''
vsp.GetParmType(pid) == vsp.PARM_DOUBLE_TYPE     # 0..6，常量已提供
vsp.GetParmLowerLimit(pid), vsp.GetParmUpperLimit(pid)  # 无界时是 None
vsp.GetParmActiveFlag(pid)
vsp.GetParmName(pid), vsp.GetParmGroupName(pid), vsp.GetParmDisplayGroupName(pid)
info = vsp.GetParmInfo(pid)   # 含 active/lower/upper/groupName，可一次取齐

vsp.SetParmValUpdate(pid, 14.0)                  # 按 ID
vsp.SetParmValUpdate(w, 'TotalSpan', 'WingGeom', 16.0)  # 按几何/名/组
```

- **组名有两种**：`FindParm`、`GetParmVal(geom,name,group)`、`SetParmVal` 使用**内部组名**
  （`GetParmGroupName`）；`GetParmInfo()['group']` 是**显示组名**（`GetParmDisplayGroupName`，用于 UI）。
  带后缀/别名的参数两者可能不同。
- `SetParmValUpdate` 会触发模型更新，而 `SetParmVal`/`SetParmValByID` 不会；它也不做 limits/active 预检，
  与桌面语义一致。
- 参数读取是逐次引擎调用，不是原子快照；修改一个参数后，别的参数的 active/limits 可能随之变化。

### 分析扩展（CompGeom）

`CompGeom` 已加入白名单，并在运行时强制关闭 TXT/CSV 输出与 mode：

```python
vsp.SetAnalysisInputDefaults('CompGeom')
vsp.SetIntAnalysisInput('CompGeom', 'Set', [vsp.SET_ALL])
root = vsp.ExecAnalysis('CompGeom')     # 结果名 'Comp_Geom'
vsp.GetDoubleResults(root, 'Total_Wet_Area')
vsp.GetDoubleResults(root, 'Total_Wet_Vol')
```

- 尊重 `Set`、`DegenSet`、`HalfMeshFlag`、`SubSurfFlag`；`WriteTXTFlag`/`WriteCSVFlag`/`UseModeFlag` 强制为 0，
  因此不会写 `comp_geom.txt`/`.csv`。
- **原生副作用（与桌面一致）**：CompGeom 会向模型新增一个 `Mesh` 几何、把其它几何全部隐藏，并改变活动几何。
  需要恢复时自行清理：

  ```python
  # 必须在 ExecAnalysis('CompGeom') 之前记录；原有 Mesh 不应被删除。
  before = set(vsp.FindGeoms())
  shown = {g: vsp.GetSetFlag(g, vsp.SET_SHOWN) for g in before}
  root = vsp.ExecAnalysis('CompGeom')
  created = set(vsp.FindGeoms()) - before
  for g in created:
      if vsp.GetGeomTypeName(g) == 'Mesh':
          vsp.DeleteGeom(g)  # 仅在确认需要清理后删除本次新增的 Mesh
  for g, was_shown in shown.items():
      vsp.SetSetFlag(g, vsp.SET_SHOWN, was_shown)
  # 活动几何也会改变，此示例不恢复选择状态。
  ```

- 大模型上 CompGeom 可能较慢（布尔/求交），仍受同步桥 60 秒与无取消约束。

### 分析扩展（MassProp）

目前支持 `DegenGeom`、`SurfacePatches`、`MassProp` 和 `CompGeom`：

```python
vsp.ListAnalysis()                     # 引擎知道的全部分析名
vsp.GetAnalysisInputNames('MassProp')  # ['DegenSet', 'MassSliceDir', 'ModeID', ...]
vsp.GetAnalysisInputType('MassProp', 'Set')   # 1 = INT_DATA；未知输入 -1
vsp.GetSetIndex('All'), vsp.GetGeomSet('All')

vsp.SetAnalysisInputDefaults('MassProp')
vsp.SetIntAnalysisInput('MassProp', 'Set', [vsp.SET_ALL])
vsp.SetIntAnalysisInput('MassProp', 'NumMassSlices', [10])
root = vsp.ExecAnalysis('MassProp')    # 结果名 'Mass_Properties'
vsp.GetDoubleResults(root, 'Total_Mass')
vsp.GetVec3dResults(root, 'Total_CG')
```

- `SetIntAnalysisInput` 现在按分析**声明的输入类型**校验（`INT_DATA`），不再写死四个名字；未知输入仍报
  `Unsupported analysis input`。
- `MassProp` **尊重调用方的 `Set`**（可做按集合的质量特性）；`UseModeFlag` 强制为 0，因此字符串输入
  `ModeID`（mode 模式）暂不支持。
- `DegenGeom`/`SurfacePatches` 保持原策略：强制全模型、不写文件、不应用 mode。
- 质量特性在细分片数大时可能较慢，仍受同步桥 60 秒上限约束。

### 几何层级与改名

```python
w = vsp.AddGeom('WING')
pod = vsp.AddGeom('POD', w)
vsp.Update()

vsp.GetGeomParent(w)        # 'NONE'（顶层）
vsp.GetGeomParent(pod)      # w
vsp.GetGeomChildren(w)      # [pod, ...]，模型顺序
vsp.GetGeomChildren(pod)    # []

vsp.SetGeomName(w, 'MainWing')
vsp.GetGeomName(w)          # 立即为 'MainWing'
vsp.FindGeom('MainWing')    # w
```

- `FindGeoms`/`FindGeom`/`GetGeomName`/`GetGeomTypeName` 现在直接在引擎线程读取，不再依赖页面
  `GET /model` 快照，所以改名后同一段脚本里立刻可见。
- `GetGeomParent` 返回原生值：顶层几何是 `'NONE'`，不是空串。
- `SetGeomName` 与原生一致：会触发模型更新；自命名几何（Clone、部分派生几何）拒绝改名并抛 `OpenVSPError`；
  名称限 1–256 UTF-8 字节，写入后读回校验。

### 结果管理

长会话里分析结果会一直留在 ResultsManager 中（与桌面一致），因此补了按名查找与清理：

```python
names = vsp.GetAllResultsNames()            # ['DegenGeom', ...]
count = vsp.GetNumResults('DegenGeom')      # 同名结果数量
first = vsp.FindResultsID('DegenGeom', 0)   # 第 index 个；不存在返回 ''
latest = vsp.FindLatestResultsID('DegenGeom')
vsp.DeleteResult(first)                     # 未知 ID 为空操作
vsp.DeleteAllResults()                      # 清空
```

- 查找与计数直接读 ResultsMgr，`FindResultsID`/`FindLatestResultsID` 找不到时返回空串（原生会入队一个错误，
  这里按空结果处理）。
- 删除只影响 ResultsMgr，不改变几何；分析结果被删后需重新 `ExecAnalysis`。

### Python 工作区与文件 API

7 个同步文件 API 已复刻；浏览器侧的异步工作全部由页面承担：

| API | 行为 |
| --- | --- |
| `ReadVSPFile(name)` | 清空模型并从引擎文件系统读取 `.vsp3`，成功后把模型文件名设为该路径 |
| `WriteVSPFile(name, set=SET_ALL)` | 按 Save As 语义写整个模型并设置模型文件名 |
| `ExportFile(name, set=SET_ALL, type=EXPORT_STL, ...)` | 导出几何；仅支持原生默认可选参数，STEP 未编译 |
| `ImportFile(name, type=IMPORT_STL, parent='')` | 导入文件并返回几何 ID；不支持指定父几何 |
| `SetVSP3FileName(name)` / `GetVSPFileName()` | 只改/读模型文件名，不写文件 |
| `ClearVSPModel()` | 清空几何与结果 |

**路径规则**：`/...` 绝对路径直接使用；相对路径（含反斜杠）解析到 `/work`，`..` 一律拒绝，不能跳出工作区。
`GetVSPFileName()` 返回绝对引擎路径，可直接喂回 `ReadVSPFile`。

**工作区**（控制台标题栏下方一行）：

- **选择文件夹**：递归读取并绑定文件（最多 200 个文件、64 MiB、深度 8）；超限时提示部分文件未载入。
  被绑定文件的引擎写入由 watcher 回写磁盘。
- **添加文件**：暂存到 `/work`，不会自动载入模型；用 `vsp.ReadVSPFile('文件名')` 载入。
- **同步**：将尚未绑定的文件写回所选文件夹；无文件夹或只读时使用下载。控制台运行结束后也会自动同步。
- 该功能面向单用户、单文件夹使用，不隔离多工作区或检测其他程序的并发修改；切换文件夹不会清空 `/work`。
  写入可能覆盖同名文件，建议重要模型留备份。未关联磁盘的内存文件在刷新或崩溃后丢失。
- 也可用 `import webvsp_files` 后执行 `await webvsp_files.save_from_engine('/work/文件名')` 显式导出；
  已链接文件可能直接写回，未链接文件可能弹保存选择器或回退下载，请确认实际保存。

**边界**：路径是引擎 MEMFS 路径而非宿主机路径，选择器/下载必须由页面发起，所以 Python 侧不能用相对路径
之外的任意磁盘路径；`ExportFile` 的 `thin_set`/`use_mode`/`modeID` 等高级参数不支持；导出、导入与保存的
大文件仍受浏览器内存与 WASM 内存上限约束。

**测试**：`python3 scripts/test-live-files.py` 覆盖路径与参数规则；`node scripts/file-io-browser-check.mjs`
覆盖真实浏览器中的文件 API 与同步。

### 未桥接接口的堵点与影响

剩余缺口不是“做不到”，而是有策略或依赖上的原因：

- **`GetGeomType(id)`**：**原生 API 里没有这个函数**，只有 `GetGeomTypes()`（类型名列表）和
  `GetGeomTypeName(id)`（已支持）。所以它不是缺口，不应为“补齐”去臆造一个数字类型码。
- **`SetDoubleAnalysisInput`、`SetStringAnalysisInput` 与其它分析**：门面里没有这两个函数（调用即
  `AttributeError`）；引擎的分析 op 仅允许 `DegenGeom`、`SurfacePatches`、`MassProp`、`CompGeom`，其它名字返回
  `Unknown analysis`。int 输入按分析声明的类型校验。这是**策略性白名单**，不是缺少一个 setter：
  CFD/FEA/VSPAERO 等可能按 vehicle 导出设置写文件；
  `VSPAEROSinglePoint` 还会启动求解器（页面 worker，异步，`ExecAnalysis` 立即返回）；`ParasiteDrag`
  需要 string + 多个 double 输入，并且会写 CSV、改导出路径；大模型上的时长也可能超过同步桥 60 秒上限。
  真要支持需按分析逐项定义：允许的输入类型与名字、文件输出策略（禁写或重定向到 MEMFS 并清理）、超时/
  取消、结果清理，以及桌面对照测试。下一步成本分级：`ParasiteDrag` 较高（需要 double/string 输入、CSV/导出路径处理，且会改导出文件名），
  VSPAERO/CFD/FEA 与同步桥语义冲突、不建议在控制台做。

### 未实现原因分类

1. 原生扩展不可用：桌面 `openvsp` 是 CPython 扩展，必须逐函数桥接；没写进门面的函数即不存在。
2. 缺引擎操作：每个 API 需要 `engine.cpp` 的 op + `syncProbe.ts` 路由。
3. 桌面进程：Pyodide 无进程，VSPAERO 由页面 worker 承担，不经 Python。
4. 文件边界：浏览器选择器与虚拟 FS 不能替代桌面任意路径读写。
5. 分析白名单与副作用：只开放四种分析；集合、文件输出和 mode 策略按分析区分。
6. 绘图/重依赖未打包：matplotlib、pandas、f90nml、fortranformat 等。
7. 上游自身缺陷：`files.RunManager` 的 `collections.Iterable`、`atmosphere` 整数 dtype 截断与 0 m 求根越界；保持源码原样，只记录不修改。
8. 实验路径主动禁用：递归结果树无法证明有界且无损。

## 测试

| 目标 | 命令（在 `web/frontend` 下） |
| --- | --- |
| 脚本与导入别名 | `python3 scripts/test-live-imports.py` |
| 控制台错误/超时语义 | `python3 scripts/test-live-errors.py` |
| 二进制与字符串协议 | `python3 scripts/test-live-binary.py`、`python3 scripts/test-live-strings.py` |
| 批量快照 | `python3 scripts/test-live-result-batch.py` |
| 结果管理 | `python3 scripts/test-live-results.py` |
| 参数元数据 | `python3 scripts/test-live-params.py` |
| 几何层级/改名、原生 XS/SS 枚举对照 | `python3 scripts/test-live-geometry.py` |
| 分析发现 | `python3 scripts/test-live-analysis.py` |
| 文件 API 路径/参数 | `python3 scripts/test-live-files.py` |
| 上游模块数值 | `python3 scripts/test-native-atmosphere.py`、`test-native-uberlogging.py`、`test-native-wt-util.py` |
| 源码一致性 | `node scripts/check-native-modules.mjs` |
| 真实浏览器（先构建并启动预览） | `console-smoke.mjs`、`live-analysis-smoke.mjs`、`scipy-console-browser-check.mjs`、`delete-clone-browser-check.mjs`、`live-binary-browser-check.mjs`、`results-browser-check.mjs`、`params-browser-check.mjs`、`geometry-browser-check.mjs`、`analysis-browser-check.mjs`、`compgeom-browser-check.mjs` |

上表浏览器脚本需要 `CHROMIUM_PATH` 与 `WEBVSP_URL`（默认 `http://127.0.0.1:4173/`）。
`src/dualWasmProbe/xsec-subsurf-wasm-check.mjs` 使用 `WEBVSP_TEST_CHROMIUM` 和 `WEBVSP_TEST_PAGE`，
须指向隔离测试页面及匹配的 WASM；它覆盖原生类型、错误及 Python 控制台桥接。
`?dualWasmProbe=1` 只注册测试入口 `__runPython`；产品入口是顶栏 **Python Console** 按钮。

测试证据窄于“完整包兼容”：模块安装成功不代表其中每个函数都在浏览器验证过，未标 ✅ 的接口按“可能失败”对待。

## 历史结论

以下来自已删除的固定诊断与生成脚本，作为记录保留，不可复现：

- 静态审计 `src/python_api/packages`：43 个非测试模块、431 个函数/方法、78 个类；分层 A0 纯 Python 3 个、
  A1 依赖未知 18 个、B 模型 API 1 个、C 混合环境 10 个、D 外部环境 11 个。分层只是分诊信号，不是兼容性结论。
- Pyodide（Python 3.14.2）中：未装依赖时 `numpy`/`six` 相关模块不可导入；`subprocess` 报
  `OSError: [Errno 138] emscripten does not support processes`。
- 加载 pinned NumPy/six 后，`units`、`transformations`、`files`、`openvsp.utilities` 的**原始源码**可导入；
  原始 `get_wing_reference_quantities` 在单机翼上返回 `[45, 18, 2.5]`，与引擎独立读回一致（一个函数、一个模型，
  不代表整包兼容）。
- 结论：可导入 ≠ 可用；文件、绘图、进程与外部求解器路径需要单独替代或明确不支持。这些判断已体现在上文清单中。
