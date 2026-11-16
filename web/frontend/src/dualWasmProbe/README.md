# 浏览器内 Python 控制台

本目录只保留一条可在页面上使用的 Python 路径：**Python 控制台（live）**，包括顶栏 **Python Console**
按钮、`window.__runPython` 和脚本模式。Python 运行在持久 Pyodide worker 中，`openvsp` 调用经同步桥交给
页面的 OpenVSP 引擎线程，直接读写**当前页面模型**。

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
- 分析白名单只有 `DegenGeom` 与 `SurfacePatches`。`SetIntAnalysisInput` 只接受单个整数、`index=0`，且只允许
  `Set`、`WriteCSVFlag`、`WriteMFileFlag`、`UseModeFlag`；运行时强制 `Set=SET_ALL`、关闭文件输出与 mode，
  所以调用方设置的 `Set` 会被覆盖。分析结果留在页面 ResultsManager 中，后续调用仍可读取。
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

## 兼容性清单

标记：**✅** 已实现并有自动测试；**🟨** 已实现但未单独测试；**🚫** 存在但被桥接层禁用；**❌** 未实现
（调用得到 `AttributeError`/`NameError`）。逐项“验证”指本目录测试脚本，见文末。

### `openvsp` 门面（`python/openvsp_live.py`）

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `OpenVSPError`、`get_instance()` | ✅ | 错误带 `outcome`/`actual`/`code`；只接受本模块，第二实例直接 `ValueError` |
| `SET_ALL`、数据类型常量、`CLONE_DELETE_*` | ✅ | `SET_ALL=0` 构建时与 `APIDefines.h` 校验 |
| `XS_*`、`SS_*` 常量 | 🟨 | 只写死一小部分，不是完整枚举 |
| `AddGeom`、`DeleteGeom`、`Update`、`FindGeoms`、`FindGeom` | ✅ | `DeleteGeom` 支持三种克隆策略；`Update` 参数被忽略，始终完整更新 |
| `GetGeomName`、`GetGeomTypeName`、`GetGeomParmIDs` | ✅ | |
| `GetParmVal(geom,name,group)`、`SetParmVal(...)` | ✅ | 不支持桌面的单参数 `GetParmVal(parm_id)` 重载 |
| `GetParmInfo`、`GetParmInfoByName`、`GetParmValByID`、`SetParmValByID` | ✅ | |
| `GetNumXSecSurfs`、`GetXSecSurf`、`GetXSec`、`GetXSecParmIDs`、`DeleteXSec`、`ChangeXSecShape(ByID)` | 🟨 | 已桥接，未单独测试 |
| `GetXSecSurfIDs`、`GetNumXSec`、`GetXSecIDs`、`GetXSecShape`、`InsertXSec`、`CutXSec` | ✅ | |
| `GetNumSubSurf`、`GetSubSurf`、`DeleteSubSurf` | 🟨 | 已桥接，未单独测试 |
| `GetSubSurfIDVec`、`AddSubSurf` | ✅ | |
| `GetNumSets`、`GetSetName`、`GetSetFlag` | ✅ | |
| `GetSetNames`、`SetSetName`、`SetSetFlag` | 🟨 | 已桥接，未单独测试 |
| `SetAnalysisInputDefaults`、`SetIntAnalysisInput`、`ExecAnalysis` | ✅ | 仅 `DegenGeom`/`SurfacePatches`，且强制全模型、不写文件、不应用 mode |
| `SetDoubleAnalysisInput`、`SetStringAnalysisInput` 及其它分析 | ❌ | 未桥接 |
| `GetAllResultsIDs`、`GetAllDataNames`、`GetResultsName`、`GetResultsType` | ✅ | |
| `GetNumData`、`GetResultShape`、`GetBinaryResults` | 🟨 | 后两者是诊断用、非桌面上游接口 |
| `GetIntResults`/`GetDoubleResults`/`GetStringResults`/`GetDoubleMatResults`/`GetVec3dResults` | ✅ | `Vec3d` 只提供 `x()/y()/z()` |
| `parse_results_object`、`GetResultSnapshotCapabilities`、`GetResultSnapshots` | ✅ | 见“运行机制与限制” |
| `GetResultTree`、`parse_results_tree`、`parse_results_object_fast`、`parse_surface_patches_fast` | 🚫 | 递归结果树被固定拒绝 |
| `SetGeomName`、`GetGeomParent`、`SetParmValUpdate` | ❌ | 未桥接；引擎/页面已有可用数据或操作，缺少路由与守卫（见下节）。`GetGeomType` 不是原生接口，只有 `GetGeomTypeName`/`GetGeomTypes` |

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
| `plot_propeller_info`、`set_3d_axis_equal`、`run_degen_geom`、`genX3d`、`export_airfoils` | ❌ | matplotlib，或需要 `GetSetIndex`/`ClearVSPModel`/`ReadVSPFile`/`ExportFile` |

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

### 未桥接接口的堵点与影响

这几个函数不是“做不到”，而是没接到 Python 门面上；堵点各不相同：

- **`SetGeomName(id, name)`**：引擎已有 `guardedSetGeomName`（校验当前模型、非自动命名、≤256 字节，写入后读回校验，
  不一致报 `different`/`unknown`）。堵点在于控制台写入走的是不带 epoch 的 `syncProbeEngineCall`，而 guarded 写需要
  先取 `wasmRequest('GET','/model')` 的 `modelEpoch` 再调 `callGuarded`。要暴露给 Python，需给控制台加 epoch 读取、
  一条 `live_set_geom_name` 路由、门面函数和测试；不需要改 C++。影响：批量脚本里的改名会直接 `AttributeError`，
  目前只能通过镜像 GUI 改名。
- **`GetGeomParent(id)`**：没有引擎 op 也不需要有——页面 `GET /model` 的每个几何已经带 `parent`/`children`，
  控制台的 `FindGeoms`/`GetGeomName` 本来就在读这份数据。堵点仅是“没人写这层门面函数”。影响：脚本无法直接查父子
  关系；注意它和现有几何查询一样是页面快照，不是引擎线程上的原子读。
- **`GetGeomType(id)`**：**原生 API 里没有这个函数**，只有 `GetGeomTypes()`（类型名列表）和
  `GetGeomTypeName(id)`（已支持）。所以它不是缺口，不应为“补齐”去臆造一个数字类型码。
- **`SetParmValUpdate(parm_id, value)`**：原生有两个重载（按参数 ID 或 geom/name/group）。引擎已有 `setParm`
  （直接调 `vsp::SetParmValUpdate`，页面保存参数走的就是它）和更严格的 `geomSetParm`（检查 limits/active、
  读回校验）。堵点是控制台只暴露了 `liveParmSet`/`liveParmSetById`，它们调用的是 `vsp::SetParmVal`（不触发更新），
  没有路由到这两个 op。影响：脚本里的 `SetParmValUpdate` 会 `AttributeError`；可先 `SetParmValByID(pid, v)` 再
  `vsp.Update()` 近似替代，但更新时机与副作用不完全等价。

- **`SetDoubleAnalysisInput`、`SetStringAnalysisInput` 与其它分析**：门面里没有这两个函数（调用即
  `AttributeError`）；引擎的分析 op 也把分析名限定为 `DegenGeom`/`SurfacePatches`，其它名字返回
  `Unknown analysis`，int 输入只认四个固定名字。这是**策略性白名单**，不是缺少一个 setter：
  `CompGeom`/CFD/FEA/VSPAERO 系列会按 vehicle 导出设置写文件（浏览器只有 MEMFS，写出来也拿不到）；
  `VSPAEROSinglePoint` 还会启动求解器（页面 worker，异步，`ExecAnalysis` 立即返回）；`ParasiteDrag`
  需要 string + 多个 double 输入，并且会写 CSV、改导出路径；大模型上的时长也可能超过同步桥 60 秒上限。
  真要支持需按分析逐项定义：允许的输入类型与名字、文件输出策略（禁写或重定向到 MEMFS 并清理）、超时/
  取消、结果清理，以及桌面对照测试。成本分级：`MassProp`（全 int、无文件）最低，`CompGeom` 中等，
  `ParasiteDrag` 较高，VSPAERO/CFD/FEA 与同步桥语义冲突、不建议在控制台做。

### 未实现原因分类

1. 原生扩展不可用：桌面 `openvsp` 是 CPython 扩展，必须逐函数桥接；没写进门面的函数即不存在。
2. 缺引擎操作：每个 API 需要 `engine.cpp` 的 op + `syncProbe.ts` 路由。
3. 桌面进程：Pyodide 无进程，VSPAERO 由页面 worker 承担，不经 Python。
4. 文件边界：浏览器选择器与虚拟 FS 不能替代桌面任意路径读写。
5. 分析白名单与副作用：只开放两种分析，且强制全模型、不写文件、不应用 mode。
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
| 上游模块数值 | `python3 scripts/test-native-atmosphere.py`、`test-native-uberlogging.py`、`test-native-wt-util.py` |
| 源码一致性 | `node scripts/check-native-modules.mjs` |
| 真实浏览器（先构建并启动预览） | `console-smoke.mjs`、`live-analysis-smoke.mjs`、`scipy-console-browser-check.mjs`、`delete-clone-browser-check.mjs`、`live-binary-browser-check.mjs` |

浏览器脚本需要 `CHROMIUM_PATH` 与 `WEBVSP_URL`（默认 `http://127.0.0.1:4173/`）。`?dualWasmProbe=1`
只注册测试入口 `__runPython`；产品入口是顶栏 **Python Console** 按钮。

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
