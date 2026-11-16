# 浏览器 Python 兼容性清单

本清单描述 **页面内 Python 控制台**（`Python Console`、`window.__runPython`、脚本模式）实际能用的上游
`src/python_api` 代码。不包含独立的只读/建模探测（它们用另一套更小的 `_sync_generated.py` 门面），
也不代表桌面 OpenVSP 的能力。上游源码路径均相对 `src/python_api/packages/`。

**判定口径**

| 标记 | 含义 |
| --- | --- |
| ✅ 已实现并验证 | 已桥接到引擎并有自动化测试（真实浏览器或宿主测试）覆盖 |
| 🟨 已实现，未单独验证 | 代码与桥接路由都存在，但没有专门测试；行为以调用时返回为准 |
| 🚫 存在但已禁用 | 函数存在，但桥接层固定拒绝，调用必然失败 |
| ❌ 未实现 | 门面/引擎里没有对应实现，调用是 `AttributeError` 或 `NameError` |

“验证”指本仓库脚本：`console-smoke.mjs`、`p1-live-smoke.mjs`、`live-binary-browser-check.mjs`、
`scipy-console-browser-check.mjs`、`delete-clone-browser-check.mjs`、`test-live-*.py`、
`test-native-*.py`、`test-wing-reference.py`。

---

## 一、`openvsp` 门面（`python/openvsp_live.py`）

桌面 `openvsp` 是 SWIG 生成的 CPython 扩展（`_vsp`），浏览器无法加载；这里是一个行为相似的受限门面，
每个函数都对应一次引擎操作。

### 1.1 基础、常量与错误

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `OpenVSPError` | ✅ | 带 `outcome`（`not_written`/`unknown`/`different`）、`actual`、`code`；超时后写入结果不确定 |
| `get_instance(vsp_instance=None)` | ✅ | 只接受本模块；其它实例或第二实例直接 `ValueError`，避免脚本误以为存在多实例 |
| `SET_ALL` | ✅ | 固定 `0`，与 `APIDefines.h` 一致（构建时校验） |
| `INT_DATA`/`DOUBLE_DATA`/`STRING_DATA`/`VEC3D_DATA`/`INT_MATRIX_DATA`/`DOUBLE_MATRIX_DATA` | ✅ | 仅这些结果类型常量 |
| `CLONE_DELETE_LEAVE_EMPTY`/`WITH_ORIGINAL`/`REPLACE`、`CLONE_DELETE_NUM_TYPES` | ✅ | 三种删除策略均已实现并测试 |
| `XS_*`、`SS_*` 常量 | 🟨 | 只有门面里写死的一小部分（4/6 系列、双凸、楔形、椭圆、文件翼型；矩形/椭圆/控制面/线/有限线），不是完整枚举 |

### 1.2 几何与参数

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `AddGeom(type, parent='')` | ✅ | 任意已注册几何类型；返回新 ID |
| `DeleteGeom(geom_id, clone_delete=CLONE_DELETE_LEAVE_EMPTY)` | ✅ | 三种克隆策略；留空策略报克隆原件丢失错误，`outcome="unknown"`（删除已发生，勿重试） |
| `Update(update_managers=True)` | ✅ | **参数被忽略**，始终执行完整 `vsp::Update()`；与桌面“按需更新管理器”不完全等价 |
| `FindGeoms()` | ✅ | 当前模型顺序 |
| `FindGeom(name, index=0)` | ✅ | 精确名；不存在返回空串（不抛异常） |
| `GetGeomName(id)` | ✅ | |
| `GetGeomTypeName(id)` | ✅ | 类型名，如 `WingGeom` |
| `GetGeomParmIDs(id)` | ✅ | 参数 ID 列表 |
| `GetParmVal(geom_id, name, group)` | ✅ | 任意“组/名”参数读取；**不支持**桌面的单参数 `GetParmVal(parm_id)` 重载 |
| `SetParmVal(geom_id, name, group, value)` | ✅ | 任意参数写入；返回值是原生 `SetParmVal` 实际写入的值（受原生参数限制影响） |
| `GetParmInfo(parm_id)` | ✅ | 返回字典（name/group/value/limits 等由引擎提供） |
| `GetParmInfoByName(geom_id, name, group)` | ✅ | |
| `GetParmValByID`/`SetParmValByID` | ✅ | 按参数 ID 读写 |
| `SetGeomName`、`GetGeomParent`、`GetGeomType`、`SetParmValUpdate` 等 | ❌ | 未桥接；重命名只在受限建模门面里提供 |

### 1.3 翼型剖面（XSec）

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `GetNumXSecSurfs`、`GetXSecSurf` | 🟨 | 已桥接，未单独测试 |
| `GetXSecSurfIDs(geom_id)` | ✅ | |
| `GetNumXSec` | ✅ | |
| `GetXSec` | 🟨 | 已桥接，未单独测试 |
| `GetXSecIDs(xsec_surf_id)` | ✅ | |
| `GetXSecShape(xsec_id)` | ✅ | |
| `GetXSecParmIDs` | 🟨 | 已桥接，未单独测试 |
| `InsertXSec(geom_id, index, type)` | ✅ | |
| `CutXSec(geom_id, index)` | ✅ | |
| `DeleteXSec` | 🟨 | 已桥接，未单独测试 |
| `ChangeXSecShape` / `ChangeXSecShapeByID` | 🟨 | 已桥接，未单独测试 |

### 1.4 子曲面（SubSurface）

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `GetSubSurfIDVec(geom_id)` | ✅ | |
| `GetNumSubSurf`、`GetSubSurf` | 🟨 | 已桥接，未单独测试 |
| `AddSubSurf(geom_id, type, surfindex=0)` | ✅ | |
| `DeleteSubSurf` | 🟨 | 已桥接，未单独测试 |

### 1.5 几何集合（Set）

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `GetNumSets` | ✅ | |
| `GetSetName(index)` | ✅ | |
| `GetSetNames` | 🟨 | 逐次调用 `GetSetName`，未单独测试 |
| `SetSetName` | 🟨 | 已桥接，未单独测试 |
| `GetSetFlag(geom_id, set_index)` | ✅ | |
| `SetSetFlag` | 🟨 | 已桥接，未单独测试 |

### 1.6 分析

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `SetAnalysisInputDefaults(analysis)` | ✅ | **仅** `DegenGeom`、`SurfacePatches`；其它分析返回 “Unknown analysis” |
| `SetIntAnalysisInput(analysis, name, values, index=0)` | ✅ | 只接受单个整数、`index=0`；只允许 `Set`、`WriteCSVFlag`、`WriteMFileFlag`、`UseModeFlag` |
| `ExecAnalysis(analysis)` | ✅ | 仅上面两种分析；运行前强制 `Set=SET_ALL`、关闭 CSV/M 文件输出和 mode 应用，所以调用方设置的 `Set` 在运行时**被覆盖** |
| `SetDoubleAnalysisInput`、`SetStringAnalysisInput`、`ExecAnalysis` 的其它分析 | ❌ | 未桥接；`parasite_drag` 等依赖它们 |

### 1.7 结果读取

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `GetAllResultsIDs()` | ✅ | |
| `GetAllDataNames(result_id)` | ✅ | |
| `GetResultsName(result_id)` | ✅ | |
| `GetNumData(result_id, data_name)` | 🟨 | 已桥接，未单独测试 |
| `GetResultsType(result_id, data_name)` | ✅ | 解析器内部使用 |
| `GetResultShape(result_id, name, index=0)` | 🟨 | 诊断用（只查形状、不传数据）；非桌面上游接口 |
| `GetIntResults`/`GetDoubleResults`/`GetStringResults`/`GetDoubleMatResults`/`GetVec3dResults` | ✅ | 大字段走分块；IEEE NaN/±Inf、不规则矩阵、长字符串均已验证；`Vec3d` 只提供 `x()/y()/z()` |
| `GetBinaryResults` | 🟨 | 本项目内部的二进制读取入口，非桌面上游接口 |

### 1.8 结果解析与批量快照

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `parse_results_object(result_id, vsp_instance=None)` | ✅ | 桌面语义（返回 namedtuple）；内部先用有界 VRO1 单对象快照，失败再退回逐字段读取；缓存只在本次解析内有效 |
| `GetResultSnapshotCapabilities()` | ✅ | 报告 ID 数/长度/字节上限 |
| `GetResultSnapshots(result_ids, fallback=False)` | ✅ | 显式 ID 批量；单项状态 `ok`/`unknown`/`over_limit_or_unsupported`；同一引擎任务内一致，不承诺跨请求一致 |
| `GetResultTree` | 🚫 | 桥接层固定拒绝：递归结果树无法证明有界且无损 |
| `parse_results_tree`、`parse_results_object_fast`、`parse_surface_patches_fast` | 🚫 | 依赖上面的 `GetResultTree`，调用必然失败 |

### 1.9 未实现的领域（举例，非完整列表）

| 领域 | 代表接口 | 原因 |
| --- | --- | --- |
| 文件读写/导出 | `ReadVSPFile`、`WriteVSPFile`、`ExportFile`、`ClearVSPModel`、`SetVSP3FileName` | 未桥接引擎操作；页面文件由浏览器选择器和虚拟 FS 管理 |
| VSPAERO / 外部求解器 | `SetVSPAEROPath`、求解器控制 | 由页面 worker 承担，不暴露给 Python（Pyodide 无进程） |
| 设计变量/链接/测量/材料/纹理 | `AddVar`、`AddAdvLink`、`Measure*`、`AddMaterial` 等 | 未桥接 |
| 脚本与 GUI | AngelScript、`InitGUI`、屏幕/窗口操作 | 桌面专属 |
| 参数与结果的其它重载 | `GetParmVal(parm_id)`、`GetResults*` 的矩阵/索引重载 | 门面只实现脚本常用形态 |
| 其它分析 | `ParasiteDrag`、`VSPAero`、`MassProperties` 等 | 引擎分析白名单只有两种；且桌面分析会写文件/改状态 |

---

## 二、上游 helper 模块

导入方式：既是 `openvsp.<name>`，也可用历史顶层名（两者是**同一模块对象**，不是副本）。

### 2.1 `openvsp/surface_patches.py`

| 函数 | 状态 | 说明 |
| --- | --- | --- |
| `export_surface_patches(export_set, remove_degenerate=True, vsp_instance=None)` | ✅ | 原样源码，真实浏览器验证（组件/曲面/patch 数量） |
| `SurfaceComponent`、`Surface`、`SurfacePatch` | ✅ | 数据类 |
| `plot_surface_components(...)` | ❌ | 需要 matplotlib（未打包） |

### 2.2 `openvsp/degen_geom_parse.py`

| 函数 | 状态 | 说明 |
| --- | --- | --- |
| `parse_degen_geom(result_id, vsp_instance=None)` | ✅ | 原样源码，DegenGeom 真实浏览器验证 |

### 2.3 `openvsp/utilities.py`

| 函数 | 状态 | 说明 |
| --- | --- | --- |
| `parse_results_object` | ✅ | **被门面的优化版覆盖**（同一语义，内部快照+缓存）；上游实现仍被门面调用 |
| `convert_vec3d_array_to_list_matrix`、`convert_double_tuple_to_list_matrix` | ✅ | 纯转换 |
| `get_wing_reference_quantities(...)` | 🟨 | 只读探测的浏览器测试验证过该函数；live 控制台只验证了可导入与模块身份，未在控制台单独运行 |
| `get_propeller_thrust_vectors(...)`、`get_single_propeller_info(...)` | 🟨 | 依赖含 Prop 的 DegenGeom 结果与通用参数读取；代码上可行，但未在浏览器专门验证 |
| `plot_propeller_info(...)` | ❌ | matplotlib |
| `set_3d_axis_equal(ax)` | ❌ | matplotlib 轴对象 |
| `run_degen_geom(...)` | ❌ | 需要 `GetSetIndex`（未实现），且依赖多输入设置 |
| `genX3d(...)` | ❌ | 需要 `ClearVSPModel`/`ReadVSPFile`/`ExportFile` |
| `export_airfoils(...)` | ❌ | 需要 `ExportFile(..., EXPORT_SELIG_AIRFOIL)`，并依赖 `vsp_airfoils`（matplotlib） |

### 2.4 `degen_geom` 包

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 数据类（`DegenGeom`、`DegenSurf`、`DegenStick`、`DegenHinge`、`DegenPoint`、`DegenDisk`、`DegenPlate`、`DegenComponent`） | ✅ | 解析结果就是这些对象 |
| `DegenGeomMgr` | 🟨 | 纯 Python 分组逻辑，未单独测试 |
| `plot_copies`、`plot_copies_plates` | ❌ | 延迟导入 matplotlib，调用即失败 |

---

## 三、`utilities` 包

`utilities/__init__.py` 只导出 `files`；其余模块要显式 `import utilities.<name>`。

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| `units.py` | ✅ | 纯 `math` 换算；已验证 `degC2degF`、`gauge2diam`；`tas2eas`/`eas2tas` 需要大气对象（SciPy） |
| `transformations.py` | ✅ | 纯 NumPy；`TransMatrix` 在只读探测和翼参考量路径上验证 |
| `files.py` | 🟨 | `split_filename`、`AsciiFile`、`BinaryFile`、`StructUnpack` 可用（仅虚拟 FS）。`RunManager` 基本目录管理可用，但传 `copyfiles` 时上游使用 Python ≥3.10 已移除的 `collections.Iterable`，会 `AttributeError`（上游自身缺陷，未修改） |
| `uberlogging.py` | ✅ | 原样源码；`%`、`{}`、默认风格均有测试 |
| `wt_util.py` | ✅ | 原样源码；`find_nearest`、`merge_files`、`archive`、`archive_file`、`remove_file(s)` 在临时目录测试。`keyboard()` 需要交互，不适合 worker；所有文件操作只作用于虚拟 FS |
| `atmosphere.py` | ✅ | 原样源码，SciPy 按需安装。`stdatm1976`、`Hot`/`Cold`/`Tropical`/`Polar`、`geomAlt2DensAlt`/`densAlt2GeomAlt` 可用；已记录上游行为：整数数组输入会截断比值、0 m 密度高度求解越界报错、基类 `Atmosphere` 是抽象类 |
| `simple_rotor_calcs.py` | ✅ | 原样源码；`ct` 数值与定义一致，其余为纯数值+大气函数（🟨 未逐个测试） |
| `plots.py`、`runners.py` | ❌ | 未打包：前者需要 matplotlib/pandas，后者需要 `multiprocessing_logging` 与进程 |

---

## 四、未打包的模块及原因

| 模块 | 状态 | 原因 |
| --- | --- | --- |
| `openvsp.parasite_drag` | ❌ | 导入即求值 `V_UNIT_MACH`（门面未定义）；扫掠需要未实现的分析设置；上游会把模型文件名改成 `/dev/null`，且ParasiteDrag 可能经独立导出路径写 CSV；绘图/插值还需 matplotlib/scipy |
| `vsp_airfoils` | ❌ | 顶层 `import matplotlib.pyplot`；且依赖文件读写 |
| `AvlPy` | ❌ | 需要启动外部 AVL 进程、pandas、fortranformat |
| `CHARM` | ❌ | 需要外部求解器/bg2charm、scipy、pandas、opencv、pyautogui 等 |
| `pyPMARC` | ❌ | 需要外部 PMARC、pydantic、f90nml、matplotlib |
| `PyVSP` | ❌ | wxPython/VTK 桌面界面，不是 WebVSP 的交互方式 |
| `openvsp_config`、SWIG `_vsp`、`facade` | ❌ | CPython ABI 扩展与 TCP/子进程 facade，浏览器不可用 |

---

## 五、依赖与资源

| 依赖 | 状态 | 说明 |
| --- | --- | --- |
| NumPy 2.4.6、six 1.17.0 | ✅ 预装 | 同源 vendored wheel，构建时校验 SHA-256 与 Pyodide lock |
| SciPy 1.18.0 | ✅ 按需 | 约 14 MB；命令静态 `import` 到相关模块才安装；动态导入会给出提示并在后台安装 |
| matplotlib、pandas、f90nml、fortranformat、multiprocessing_logging、opencv、wx、VTK | ❌ | 未打包；相关函数因此不可用 |
| 进程（`subprocess`） | ❌ | Pyodide 报 `OSError: emscripten does not support processes` |
| 文件系统 | 🟨 | Pyodide 内存 FS；与页面模型/宿主机磁盘不自动互通 |

---

## 六、未实现原因分类

1. **原生扩展不可用**：桌面 `openvsp` 是 CPython 扩展，必须由门面逐函数桥接；没写进 `openvsp_live.py` 的函数即不存在。
2. **缺引擎操作**：每个 API 需要 `engine.cpp` 的 op + `syncProbe.ts` 路由；未桥接就调用不到原生实现。
3. **桌面进程**：Pyodide 无进程，VSPAERO 等由页面 worker 承担，不经 Python。
4. **文件边界**：浏览器文件选择器与虚拟 FS 不能替代桌面的任意路径读写。
5. **分析白名单与副作用**：只开放 DegenGeom/SurfacePatches，且强制全模型、不写文件、不应用 mode。
6. **绘图依赖**：matplotlib 未打包，绘图函数调用即失败。
7. **重依赖未打包**：pandas、f90nml、fortranformat 等。
8. **上游自身缺陷**：如 `files.RunManager` 的 `collections.Iterable`、`atmosphere` 整数 dtype 截断与 0 m 求根越界；保持源码原样，只记录不修改。
9. **实验路径主动禁用**：递归结果树无法证明有界且无损，桥接层固定拒绝。

---

## 七、复现方式

```bash
cd web/frontend
node scripts/check-native-modules.mjs && python3 scripts/test-sync-native.py
python3 scripts/test-live-imports.py && python3 scripts/test-native-uberlogging.py
python3 scripts/test-native-wt-util.py && python3 scripts/test-native-atmosphere.py
python3 scripts/test-live-errors.py && python3 scripts/test-live-binary.py
python3 scripts/test-live-result-batch.py && python3 scripts/test-live-strings.py
```

浏览器（需要先构建并启动预览）：

```bash
CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/console-smoke.mjs
CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/p1-live-smoke.mjs
CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/scipy-console-browser-check.mjs
CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/delete-clone-browser-check.mjs
CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/live-binary-browser-check.mjs
```

测试证据窄于“完整包兼容”：即便某模块安装成功，也不代表其中每个函数都在浏览器验证过；未标 ✅ 的接口按“可能失败”对待。
