# 浏览器内 Python：在线控制台与隔离分析

本目录只保留一条能在页面上使用的 Python 路径：**Python 控制台（live）**，包括 `Python Console`、
`window.__runPython` 和脚本模式。Python 运行在持久 Pyodide worker 中，`openvsp` 调用经同步桥交给页面的
OpenVSP 引擎线程，直接读写**当前页面模型**。

原先的隔离分析窗口（顶栏 **Geometry analysis / 几何分析**）以及配套的一次性 WASM/Pyodide 分析链已删除；
它曾把当前模型序列化后在一次性实例里跑 `DegenGeom`/`SurfacePatches`。同样的分析现在只能在控制台里运行
（会占用引擎线程，见下文限制）。早期用于验证桥接的固定诊断也已删除，结论保留在
[PYTHON_PACKAGE_AUDIT.md](PYTHON_PACKAGE_AUDIT.md)、[PYTHON_PACKAGE_SAMPLING.md](PYTHON_PACKAGE_SAMPLING.md)
和 [PYTHON_COMPATIBILITY.md](PYTHON_COMPATIBILITY.md) 中。

## 上游包镜像

`python/packages/` 与 `src/python_api/packages` 使用**相同的相对路径**，只放实际随页面分发的上游文件：

```
python/packages/openvsp/openvsp/{utilities,degen_geom_parse,surface_patches}.py
python/packages/degen_geom/degen_geom/{__init__,degen_geom}.py
python/packages/utilities/utilities/{__init__,files,units,transformations,uberlogging,wt_util,atmosphere,simple_rotor_calcs}.py
```

目录里没有的文件就是浏览器里没有提供的文件；[python/PACKAGES.md](python/PACKAGES.md) 列出了缺口与原因，逐函数状态见
[PYTHON_COMPATIBILITY.md](PYTHON_COMPATIBILITY.md)。每个文件与上游逐字节一致，`npm run dev` / `npm run build`
前由 `scripts/check-native-modules.mjs` 按相同相对路径校验。

WebVSP 自己编写的 Python 文件留在 `python/` 顶层：`openvsp_live.py`（门面）、`live_imports.py`（导入别名）。

## 在线控制台

`Python Console` 打开后是一个持久的 Python 会话（`syncProbe.startConsoleSession`）。包被安装到 Pyodide 的
`/sync-live`：`openvsp/__init__.py` 是 WebVSP 门面，`openvsp/` 下另有三个原始助手文件，`degen_geom/` 与
`utilities/` 按上游布局复制；随后 `live_imports.py` 把 `openvsp.surface_patches` 等规范路径与历史顶层名
（`surface_patches`、`degen_geom_parse`、`openvsp_utilities`）指向**同一个模块对象**，并导出桌面版
`openvsp` 包顶层的 `export_surface_patches`、`parse_degen_geom`、`get_wing_reference_quantities`。
门面自己的优化版 `parse_results_object` 不会被覆盖，解析结果缓存只在一次解析内有效。

```python
import openvsp as vsp
import surface_patches

w = vsp.AddGeom('WING')
vsp.SetParmVal(w, 'TotalSpan', 'WingGeom', 12.0)
vsp.Update()
comps = surface_patches.export_surface_patches(vsp.SET_ALL)
[(c.name, len(c.surfaces), sum(len(s.patches) for s in c.surfaces)) for c in comps]
```

### 线程、错误与超时

- 所有 OpenVSP 调用都在页面的引擎 pthread 上执行；Python 线程通过 `SharedArrayBuffer` + `Atomics.wait`
  同步等待结果，最长 60 秒。
- 模型写入可能失败或在超时后才完成：`OpenVSPError.outcome` 为 `not_written`（派发前被拒）或 `unknown`
  （可能已执行）。超时**不会取消**已派发的引擎工作，不要自动重试，先检查模型。
- 分析执行期间引擎线程被占用，GUI 镜像与 3D 视图停止刷新，也没有取消机制；分析 OOM 或断言会连同未保存
  的修改一起结束整个页面会话。
- 这是你本人页面里的任意 Python，不是安全沙箱。

### 分析与结果

- 分析白名单只有 `DegenGeom` 与 `SurfacePatches`。`SetIntAnalysisInput` 只接受单个整数、`index=0`，且只允许
  `Set`、`WriteCSVFlag`、`WriteMFileFlag`、`UseModeFlag`；运行时强制 `Set=SET_ALL`、关闭文件输出与 mode，
  所以调用方设置的 `Set` 会被覆盖。
- 分析结果留在页面 ResultsManager 中，后续调用仍可读取。
- 数值字段用有界二进制分块，保留 IEEE NaN/±Inf 与不规则矩阵；同一字段可能在不同分块之间变化，形状变化能被
  发现，但同形状并发修改不是原子快照。
- 字符串按最多 4096 UTF-8 字节分块，支持超过响应缓冲区的单个字符串；重装后按 UTF-8 校验，畸形或变化的分块
  直接失败而不是截断。
- `parse_results_object` 先取单对象有界快照（≤512 KiB、32,768 items、1,024 字段），不支持或超限时退回逐字段
  读取。`GetResultSnapshots([id, ...])` 是显式 ID、单引擎任务内的批量接口（≤32 个 ASCII ID、每个 ≤128 字节、
  总计 ≤512 KiB），保留顺序与重复项，逐项返回 `ok`/`unknown`/`over_limit_or_unsupported`。
  它只保证同一引擎任务内一致，不承诺跨请求一致。
- 递归结果树路径（`GetResultTree`、`parse_results_tree`、`parse_results_object_fast`、
  `parse_surface_patches_fast`）因无法证明有界且无损，被桥接层固定拒绝。

### SciPy 按需安装

`utilities.atmosphere` 与 `utilities.simple_rotor_calcs` 需要 SciPy。SciPy wheel 约 14 MB，因此不在每次会话
启动时安装：命令执行前会静态扫描其中的 `import` / `from ... import`，命中相关模块才从同源安装（并把
`scipy → numpy` 依赖闭包固定校验）。扫描不执行用户代码。动态导入（`importlib.import_module`、`__import__`、
`exec`）无法被扫描到，会给出提示并在后台安装，重跑命令即可。

在本机预览服务上实测：worker 启动后安装 SciPy 约 1.1 秒，随后首次 `import scipy` 约 1.5 秒；不使用 SciPy 的
命令不承担这两项开销。

## 入口与测试

`?dualWasmProbe=1` 只注册测试入口 `__runPython`（脚本模式）。产品入口是顶栏的 **Python Console** 按钮。

| 目标 | 命令（在 `web/frontend` 下） |
| --- | --- |
| 脚本与导入别名（宿主） | `python3 scripts/test-live-imports.py` |
| 控制台错误/超时语义 | `python3 scripts/test-live-errors.py` |
| 二进制与字符串协议 | `python3 scripts/test-live-binary.py`、`python3 scripts/test-live-strings.py` |
| 批量快照 | `python3 scripts/test-live-result-batch.py` |
| 上游模块数值 | `python3 scripts/test-native-atmosphere.py`、`test-native-uberlogging.py`、`test-native-wt-util.py` |
| 源码一致性 | `node scripts/check-native-modules.mjs` |
| 真实浏览器（需已构建并启动预览） | `console-smoke.mjs`、`scipy-console-browser-check.mjs`、`delete-clone-browser-check.mjs`、`live-binary-browser-check.mjs`、`live-analysis-smoke.mjs` |

浏览器脚本需要 `CHROMIUM_PATH` 与 `WEBVSP_URL`（默认 `http://127.0.0.1:4173/`）。
