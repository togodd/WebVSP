# OpenVSP 示例移植报告（WebVSP / Python 桥）

日期：2026-11-17（第 2 版：便捷层、自定义组件、FEA 形状已补）
范围：`examples/scripts/*.vspscript`（AngelScript）代表性取样 13 个，逐个人工移植成 Python，在真实浏览器 + Pyodide + WASM 引擎里运行。
移植代码：[`scripts/examples/`](.) ｜ 运行器：[`scripts/run-examples.mjs`](../run-examples.mjs)

---

## 1. 方法

- 取样覆盖五类能力：几何建模、截面/子表面、分析、测量/查询、文件与结构。
- 移植规则（尽力保持原意，不"美化"）：
  - 去掉类型声明与 `void main()`；`Print(...)` → `print(...)`
  - `GetNumTotalErrors()`/`PopLastError()` 自由函数 → `vsp.ErrorMgrSingleton.getInstance()`
  - AngelScript 3 参便捷重载（如 `SetXSecTanAngles(xsec, XSEC_BOTH_SIDES, 0)`）→ 按原生 6 参对左右两侧各调一次
  - 已废弃的 `ComputeCompGeom()`/`ComputeDegenGeom()` → `ExecAnalysis('CompGeom'/'DegenGeom')`
  - 无法等价替换时**不静默跳过**，而是记录到 `gaps` 并打印
- 每个脚本在**全新的浏览器页面**里运行（等同用户新开一次控制台），超时 120 s。

环境：真实 Chromium + Pyodide（numpy/six）+ 新编译 `vsp.wasm`，非 mock。

---

## 2. 结果总表

| # | 示例 | 结果 | 说明 |
|---|---|---|---|
| 1 | `Fuselage.vspscript` | ✅ 完整可用 | 截面复制/粘贴/裁剪、切线、CompGeom，`Wet_Area = 349.03` |
| 2 | `SubSurface.vspscript` | ✅ 完整可用 | 子表面增删改查、按名查找、参数列表全部正确 |
| 3 | `TestAreaProj.vspscript` | ✅ 完整可用 | 三向投影面积与期望值一致（误差 < 1e-6） |
| 4 | `TestMeasure.vspscript` | ✅ 完整可用 | 标尺创建/删除、探头、距离 `4.978884` vs 期望 `4.978881` |
| 5 | `DumpResults.vspscript` | ✅ 完整可用 | 用上 `PrintResults()` 便捷函数后与原脚本一致 |
| 6 | `DegenGeom.vspscript` | ✅ 完整可用 | 自定义组件 `TransportFuse` 已可用；产出 `Degen_surf/stick/plate` |
| 7 | `CreateEditGeom.vspscript` | ✅ 完整可用 | 同上，`TransportFuse` + `WING` 建模成功 |
| 8 | `StructuresParmContainerTest.vspscript` | ✅ 完整可用 | `AddFeaStruct`/`AddFeaPart` 已桥接，FEA 结构与参数容器可读写 |
| 9 | `Wing.vspscript` | 🟡 降级可用 | 几何全部建成，`SetDriverGroup` 仍缺失（重载未桥接） |
| 10 | `Stack.vspscript` | 🟡 降级可用 | 同上 |
| 11 | `CpSlicer.vspscript` | ❌ 仍受阻 | `CpSlicer` 分析未放开，切片函数不存在 |
| 12 | `SurfaceIntersection.vspscript` | ❌ 仍受阻 | `SurfaceIntersection` 分析未放开 |
| 13 | `FEAMesh.vspscript` | ❌ 仍受阻 | `FeaMeshAnalysis/Export` 未放开；`SetFeaMeshVal` 仍缺 |

统计：**8 个完整可用、2 个降级可用、3 个仍受阻**（13/13 不再抛异常，但按实际输出语义判定如上表）。

---

## 3. 根因分类（这是下次完善的方向）

### A. 自定义组件（`.vsppart`）没有加载机制 — ✅ 已修复

`TransportFuse` 不是内置类型，而是 `examples/CustomScripts/TransportFuse.vsppart`。官方文档写明：自定义组件由 OpenVSP 在启动时从 `Custom Scripts/` 目录加载，之后才能 `AddGeom("TransportFuse")`。

浏览器里引擎的 MEMFS 没有这个目录，所以：

```
openvsp.OpenVSPError: AddGeom::Can't Find Type Name TransportFuse
```

**已修复**：`gen_custom_scripts.py` 把 `examples/CustomScripts/*.vsppart`（10 个、约 58 KB）编译进引擎，启动时写入 `/CustomScripts/`，赶在 OpenVSP 首次扫描之前。现在 `GetGeomTypes()` 里能看到 `Box`、`Disk`、`PodMan`、`TransportFuse` 等，`AddGeom('TransportFuse')` 正常。

### B. 分析未纳入白名单 — 3 例

`CpSlicer`、`SurfaceIntersection`、`FeaMeshAnalysis/FeaMeshExport` 都返回 `Unknown analysis`。

- `CpSlicer` 需要先有 VSPAERO 的 `.adb`，再跑 `vsploads` 切片（跨进程链路）
- `SurfaceIntersection` 在 `AnalysisMgr` 里注册，但执行时会改几何（新建求交几何），需要单独审查
- `FeaMesh*` 属于 FEA 网格工具，依赖结构定义

**建议**：优先级 `SurfaceIntersection`（进程内、无外部依赖）> `CpSlicer`（VSPAERO 链路已通，只差 `vsploads` 调用与 `.adb` 输入）。

### C. FEA 结构 API 缺口 — ✅ 已修复

实测缺失：`AddFeaStruct`、`AddFeaPart`、`SetFeaMeshVal`（`AddFeaMaterial` 已存在）。

原因不是"没实现"，而是**签名形状没覆盖**：

```cpp
extern int AddFeaStruct( const std::string & geom_id, bool init_skin = true, int surfindex = 0 );
extern std::string AddFeaPart( const std::string & geom_id, int fea_struct_ind, int type );
```

- `AddFeaStruct`：带默认参数 `(string, bool, int)`，签名表里没有这个形状
- `AddFeaPart`：`(string, int, int) → string`，有参数形状没有对应返回形状

**已修复**：生成器新增 `sbi` 与 `siiS` 两个形状，并**支持原生默认参数**（`DEFAULTS` 表 + 门面按缺省补齐）。`AddFeaStruct(pod)` 这种只传一个参数的调用现在可用，FEA 结构与参数容器读写正常。剩下 `SetFeaMeshVal` 等仍需单独补。

### D. 重载函数未桥接 — 2 例（`Wing`、`Stack`）

```cpp
extern void SetDriverGroup( const std::string & geom_id, int section_index, int driver_0,
                            int driver_1 = -1, int driver_2 = -1 );
```

生成器遇到**同名重载**直接跳过（避免猜错参数含义）。`SetDriverGroup` 还有其它重载，所以两个脚本的驱动组设置被跳过——几何能建，但截面驱动模式没设上。

**建议**：为高频重载写手写包装（按参数个数分派），优先 `SetDriverGroup`、`Get/SetXSecPnts`、`DeleteSubSurf` 这类常用项。

### E. AngelScript 专有 API — ✅ 部分修复

| 示例里用的 | 现状 | 替代 |
|---|---|---|
| `Print` / `PrintResults` | AngelScript/ScriptMgr 专有；`Print` 在 C++ 头里另有含义 | `print()` / 遍历 `GetAllDataNames` |
| `GetNumTotalErrors()` / `PopLastError()` 自由函数 | 已改为 `ErrorMgrSingleton` 方法 | `vsp.ErrorMgrSingleton.getInstance()` |
| `closeTo(a, b, tol)` | 不存在 | `abs(a-b) < tol` |
| `ComputeCompGeom` / `ComputeDegenGeom` | 已废弃 | `ExecAnalysis('CompGeom'/'DegenGeom')` |
| `ComputeVSPAEROCpSlices` / `GetAllCpSlices` / `IntersectGeoms` | **头文件里没有**，仅 ScriptMgr 注册过 | 暂无 |
| `SetXSecTanAngles(xsec, XSEC_BOTH_SIDES, 0)` 3 参便捷式 | 原生是 6 参 `(side, top, right, bottom, left)` | 左右两侧各调一次 |

**已修复的部分**：门面新增便捷层 `Print(*args)`（支持结尾的换行布尔）、`closeTo(a, b, tol)`、`PrintResults(result_id)`，以及自由函数版 `GetNumTotalErrors()`/`PopLastError()`。示例里这几处现在可以逐行保留。

**仍未覆盖**：`ComputeCompGeom`/`ComputeDegenGeom`（已废弃，用 `ExecAnalysis` 代替）、`SetXSecTanAngles` 三参便捷式（原生是 6 参）、`GetAllCpSlices`/`IntersectGeoms`（头文件里没有）。

---

## 4. 逐例要点

- **Fuselage**：`SetXSecTanAngles` 的 3 参便捷式是主要改写点；`Wet_Area` 正常返回。
- **SubSurface**：子表面的参数列表包含 `ParasiteDragProps_*` 组（与结构有关），属正常现象。
- **TestAreaProj**：三向面积 `1.2568322385512143 / 9.699415739470506 / 9.699415739470506`，与脚本期望值仅差 1e-8 量级。`WriteResultsCSVFile` 可用（写入引擎内存盘）。
- **TestMeasure**：`AddRuler`/`DelRuler`/`GetAllRulers`/`AddProbe` 全部可用；距离需要 `Update()` 之后才有效，与脚本注释一致。
- **Wing / Stack**：除 `SetDriverGroup` 外没有其它报错。
- **CpSlicer / SurfaceIntersection / FEAMesh**：脚本里的"准备几何"部分能跑，卡在分析执行或缺失的 FEA 函数。

---

## 5. 建议的下一步（按性价比）

已完成：便捷层、自定义组件加载、FEA 形状与默认参数。

1. **`SetDriverGroup` 手写重载**（半天）：`Wing`/`Stack` 由降级转完整的唯一缺口。
2. **`SetXSecTanAngles` 三参便捷式**（2 小时）：把 AngelScript 的"一次设两侧"补成便捷重载。
3. **补 `SetFeaMeshVal` 等 FEA 细节**（半天）：让 `FEAMesh` 脚本的建模段完整。
4. **放开 `SurfaceIntersection` 分析**（1 天）：进程内、无外部依赖。
5. **`CpSlicer` 链路**（2–3 天）：VSPAERO `.adb` → `vsploads` 切片，跨进程、风险最高。

## 6. 复现

```bash
cd web/frontend
WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ \
WEBVSP_TEST_CHROMIUM=/path/to/chrome \
WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine \
node scripts/run-examples.mjs
```

原始输出写入 `/tmp/examples-report.json`。
