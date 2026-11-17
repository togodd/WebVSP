# OpenVSP 示例移植报告（WebVSP / Python 桥）

日期：2026-11-17
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
| 4 | `TestMeasure.vspscript` | ✅ 完整可用 | 标尺创建/删除、探头、距离 `4.978884` vs 期望 `4.978881`（差 3.4e-6） |
| 5 | `DumpResults.vspscript` | ✅ 改一行可用 | `PrintResults()` 无对应 API，改为遍历 `GetAllDataNames` |
| 6 | `Wing.vspscript` | 🟡 降级可用 | 几何全部建成，但 `SetDriverGroup` 缺失，驱动组未设置 |
| 7 | `Stack.vspscript` | 🟡 降级可用 | 同上；其余截面/粘贴/切线流程正常 |
| 8 | `DegenGeom.vspscript` | ❌ 原脚本受阻 → 🟡 移植版可用 | 原脚本用自定义组件 `TransportFuse`；移植版回退到内置 `FUSELAGE` 后跑通，结果含 `Degen_surf/stick/plate/DegenGeom` |
| 9 | `CreateEditGeom.vspscript` | ❌ 受阻 | 同上；换成内置 `FUSELAGE` 后脚本自身的 `Diameter` 参数也不存在（示例专有） |
| 10 | `StructuresParmContainerTest.vspscript` | ❌ 受阻 | `AddFeaStruct` 未桥接 |
| 11 | `FEAMesh.vspscript` | ❌ 受阻 | `FeaMeshAnalysis/Export` 分析被拒，`AddFeaPart`/`SetFeaMeshVal` 未桥接 |
| 12 | `CpSlicer.vspscript` | ❌ 受阻 | `CpSlicer` 分析被拒，`ComputeVSPAEROCpSlices` 等不存在 |
| 13 | `SurfaceIntersection.vspscript` | ❌ 受阻 | `SurfaceIntersection` 分析被拒，`IntersectGeoms` 不存在 |

统计：**5 个完整可用、3 个降级可用（含回退后的 DegenGeom）、5 个受阻**。
移植后 13 个脚本中 **12 个不再抛异常**；但"不抛异常"不等于"可用"，上表按实际输出语义判定。

---

## 3. 根因分类（这是下次完善的方向）

### A. 自定义组件（`.vsppart`）没有加载机制 — 2 例

`TransportFuse` 不是内置类型，而是 `examples/CustomScripts/TransportFuse.vsppart`。官方文档写明：自定义组件由 OpenVSP 在启动时从 `Custom Scripts/` 目录加载，之后才能 `AddGeom("TransportFuse")`。

浏览器里引擎的 MEMFS 没有这个目录，所以：

```
openvsp.OpenVSPError: AddGeom::Can't Find Type Name TransportFuse
```

**影响**：所有依赖示例自定义组件的脚本（`DegenGeom`、`CreateEditGeom`、`TransportFuse` 相关）都无法直接移植。
**建议**：把 `examples/CustomScripts/*.vsppart` 打进引擎镜像的 `Custom Scripts/` 目录，或提供"上传/加载 vsppart"的入口。这是**单点投入、解锁一批示例**的改动。

### B. 分析未纳入白名单 — 3 例

`CpSlicer`、`SurfaceIntersection`、`FeaMeshAnalysis/FeaMeshExport` 都返回 `Unknown analysis`。

- `CpSlicer` 需要先有 VSPAERO 的 `.adb`，再跑 `vsploads` 切片（跨进程链路）
- `SurfaceIntersection` 在 `AnalysisMgr` 里注册，但执行时会改几何（新建求交几何），需要单独审查
- `FeaMesh*` 属于 FEA 网格工具，依赖结构定义

**建议**：优先级 `SurfaceIntersection`（进程内、无外部依赖）> `CpSlicer`（VSPAERO 链路已通，只差 `vsploads` 调用与 `.adb` 输入）。

### C. FEA 结构 API 缺口 — 2 例

实测缺失：`AddFeaStruct`、`AddFeaPart`、`SetFeaMeshVal`（`AddFeaMaterial` 已存在）。

原因不是"没实现"，而是**签名形状没覆盖**：

```cpp
extern int AddFeaStruct( const std::string & geom_id, bool init_skin = true, int surfindex = 0 );
extern std::string AddFeaPart( const std::string & geom_id, int fea_struct_ind, int type );
```

- `AddFeaStruct`：带默认参数 `(string, bool, int)`，签名表里没有这个形状
- `AddFeaPart`：`(string, int, int) → string`，有参数形状没有对应返回形状

**建议**：生成器补两个形状 `(string,bool,int)` 与 `(string,int,int)→string`，再按需补 `SetFeaMeshVal` 等。成本很低。

### D. 重载函数未桥接 — 2 例（`Wing`、`Stack`）

```cpp
extern void SetDriverGroup( const std::string & geom_id, int section_index, int driver_0,
                            int driver_1 = -1, int driver_2 = -1 );
```

生成器遇到**同名重载**直接跳过（避免猜错参数含义）。`SetDriverGroup` 还有其它重载，所以两个脚本的驱动组设置被跳过——几何能建，但截面驱动模式没设上。

**建议**：为高频重载写手写包装（按参数个数分派），优先 `SetDriverGroup`、`Get/SetXSecPnts`、`DeleteSubSurf` 这类常用项。

### E. AngelScript 专有 API（示例比 C++ API 老）— 全部示例都有

| 示例里用的 | 现状 | 替代 |
|---|---|---|
| `Print` / `PrintResults` | AngelScript/ScriptMgr 专有；`Print` 在 C++ 头里另有含义 | `print()` / 遍历 `GetAllDataNames` |
| `GetNumTotalErrors()` / `PopLastError()` 自由函数 | 已改为 `ErrorMgrSingleton` 方法 | `vsp.ErrorMgrSingleton.getInstance()` |
| `closeTo(a, b, tol)` | 不存在 | `abs(a-b) < tol` |
| `ComputeCompGeom` / `ComputeDegenGeom` | 已废弃 | `ExecAnalysis('CompGeom'/'DegenGeom')` |
| `ComputeVSPAEROCpSlices` / `GetAllCpSlices` / `IntersectGeoms` | **头文件里没有**，仅 ScriptMgr 注册过 | 暂无 |
| `SetXSecTanAngles(xsec, XSEC_BOTH_SIDES, 0)` 3 参便捷式 | 原生是 6 参 `(side, top, right, bottom, left)` | 左右两侧各调一次 |

**结论**：`examples/scripts/*.vspscript` 是按 **AngelScript 便捷层**写的，不是 C++/Python API。移植必须做一层映射。**建议在桥里提供这层便捷函数**（`Print`、`closeTo` 之类），让示例几乎可以逐行复制——这对用户体验提升最直接。

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

1. **便捷层兼容函数**（半天）：`Print`、`closeTo`、`PrintResults`、自由函数版 `GetNumTotalErrors/PopLastError` 的等价物。让示例"几乎不用改"。
2. **自定义组件加载**（1 天）：把 `examples/CustomScripts` 挂进引擎 `Custom Scripts/`，解锁 `TransportFuse` 一类示例。
3. **生成器补形状**（半天）：`(string,bool,int)`、`(string,int,int)→string`，直接补上 `AddFeaStruct`/`AddFeaPart`。
4. **重载手写包装**（1 天）：`SetDriverGroup` 优先，其次 `GetXSecPnts/SetXSecPnts`。
5. **`SurfaceIntersection` 分析**（1–2 天）：进程内、无外部依赖，收益明确。
6. **`CpSlicer` 链路**（2–3 天）：VSPAERO `.adb` → `vsploads` 切片，属于跨进程，风险高于收益。

---

## 6. 复现

```bash
cd web/frontend
WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ \
WEBVSP_TEST_CHROMIUM=/path/to/chrome \
WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine \
node scripts/run-examples.mjs
```

原始输出写入 `/tmp/examples-report.json`。
