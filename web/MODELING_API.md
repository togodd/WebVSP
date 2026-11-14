# WebVSP 浏览器内部建模接口说明

> 对应代码版本：提交 `aafc8fa` 及之后。
>
> 本文说明网页内部的建模接口：能调用什么、怎么调用、出错怎么办，以及**它不保证什么**。
> 它**不是** MCP 服务，**不是**远程接口，也**不是**安全沙箱。

## 一、先看这几条

1. 接口运行在用户打开的网页里，操作的是网页中 OpenVSP 引擎的**内存模型**。
2. 每次读写都要带一个**身份令牌**（`identity`）。模型被新建或重新打开后，旧令牌失效，调用会返回 `STALE_MODEL`。
3. 写操作（创建、移动、设置参数）会先检查、再执行、然后**回读确认**。结果不确定时返回 `OUTCOME_UNKNOWN`，**不会自动重试**。
4. 一次调用不是事务：多步操作中途失败时，可能只完成了一部分，**没有回滚**。
5. 如果有人同时在图形界面里编辑，接口**无法保证读到一致的快照**。

## 二、快速上手

```ts
import { createBrowserModelingService } from './modeling'

const svc = createBrowserModelingService()

// 1. 获取模型信息和身份令牌（不带令牌调用）
const { identity } = await svc.model.getInfo()

// 2. 创建一个机身
const { geometryId } = await svc.write.create({ type: 'FUSELAGE', parentId: null }, identity)

// 3. 列出它的参数
const parms = await svc.parameter.listGeometryParameterIds(geometryId, identity)

// 4. 沿世界坐标 X 方向移动 1 个单位
const moved = await svc.write.move(
  { geometryId, frame: 'world', units: 'model-native', delta: [1, 0, 0] },
  identity,
)
console.log(moved.origin) // 移动后的位置（已回读确认）
```

注意：

- 令牌只在**同一次页面会话、同一个模型版本**内有效。模型被替换后，请重新调用 `model.getInfo()` 取得新令牌。
- 返回的 `geometryId` 只在当前模型中有意义，不要长期保存。

## 三、接口一览

| 分组 | 方法 | 作用 | 修改模型？ |
|---|---|---|---|
| 生命周期 | `close()` | 关闭句柄；之后的新调用返回 `SESSION_CLOSED` | 否 |
| 能力 | `capabilities()` | 静态列出接口支持的功能 | 否 |
| 能力 | `protocol()` | 向引擎查询它声明的操作名称 | 否 |
| 能力 | `declaredCapabilities()` | 把引擎声明与 v1 需求对照 | 否 |
| 模型 | `model.getInfo(token?)` | 模型信息；不带令牌时返回新的身份 | 否 |
| 模型 | `model.getSelection(token)` | 当前选中的几何 | 否 |
| 模型 | `model.getVisibleSurfaceBounds(token)` | 显示中几何的包围盒 | 否 |
| 几何 | `geometry.listTypes(token)` | 引擎注册的几何类型名 | 否 |
| 几何 | `geometry.list(token)` | 模型中所有几何的摘要 | 否 |
| 几何 | `geometry.get(id, token)` | 单个几何的详细信息 | 否 |
| 参数 | `parameter.listSurfaces(id, token)` | 几何下的截面（XSec）列表 | 否 |
| 参数 | `parameter.getFuselageLength(id, token)` | 机身长度参数 | 否 |
| 参数 | `parameter.listGeometryParameterIds(id, token)` | 几何的可连接参数 ID 列表 | 否 |
| 参数 | `parameter.listCrossSectionParameterIds(id, token)` | 截面的可连接参数 ID 列表 | 否 |
| 参数 | `parameter.getGeometryParameter(id, parm, token)` | 读取几何参数 | 否 |
| 参数 | `parameter.getCrossSectionParameter(id, parm, token)` | 读取截面参数 | 否 |
| 参数 | `parameter.set(input, token)` | 设置参数值并回读 | **是** |
| 写入 | `write.create(input, token)` | 创建几何 | **是** |
| 写入 | `write.move(input, token)` | 移动几何 | **是** |
| 机翼 | `wing.get(id, token)` | 机翼的组合信息（截面与站位） | 否 |
| 机身 | `fuselage.get(id, token)` | 机身的组合信息（截面与长度） | 否 |

## 四、身份令牌（identity）

```ts
type ModelIdentity = { sessionId: string; modelEpoch: string }
```

- **sessionId**：本次页面会话的标识。
- **modelEpoch**：模型版本号（十进制字符串）。新建模型或读入文件时，引擎会让它递增。

使用规则：

- 除 `model.getInfo()` 不带参数外，所有读写都需要传令牌。
- 令牌**不是对象的身份证**。它只能说明"模型没有被替换过"，不能说明某个 ID 仍指向同一个对象（见第九节）。
- 令牌来自其他会话，或模型版本已变化：返回 `STALE_MODEL`。
- 令牌格式不对（空字符串、负数等）：返回 `INVALID_ARGUMENT`。

## 五、读取接口

### 1. 模型与几何

- `model.getInfo()` 返回模型名称、几何树等信息，并返回身份令牌。
- 几何 ID 不能为空，不能包含空白或控制字符。模型中出现重复或空 ID 时，读取返回 `ENGINE_ERROR`。
- 读取结果**不检查父子关系或拓扑是否完整**。

### 2. 参数

- 两类所有者：`geometry`（几何）和 `crossSection`（截面）。
- `listGeometryParameterIds` 的列表包含几何内嵌的截面、曲线、子面等参数。**出现在列表里不代表它属于该几何本身**；真正的所属容器见元数据的 `container` 字段。
- 元数据中的 `value`、`lowerLimit`、`upperLimit` 为有限数字，或 `null`（`null` 表示引擎报告的是非有限数）。
- `active` 只表示"当前是否活动"，**不代表一定可编辑**。
- 元数据不包含单位信息。

### 3. 机翼与机身（组合读取）

- `wing.get`：每个机翼面的截面站位，有序，每个面内序号从 0 开始。
- `fuselage.get`：每个机身面的截面（有序）及机身长度参数。
- 形状值是引擎枚举 `XSEC_CRV_TYPE` 的原始整数，只是**观察值**；引擎版本变化后，数值含义可能不同。
- 这两个接口内部会发起多次引擎请求，**不是一次性快照**。操作期间若有修改，结果可能混合两个状态。
- 它们不提供完整尺寸、翼型几何或编辑能力。

## 六、写入接口

### 1. `write.create`

```ts
write.create({ type: string; parentId: string | null }, identity)
// 返回 { geometryId: string }
```

- 已验证的类型：`WING`、`FUSELAGE`。引擎只允许固定的已知类型，其他类型会被拒绝。
- `parentId: null` 表示不指定父几何。
- 创建后会回读新几何的 ID 与类型，与请求比对。

### 2. `write.move`

```ts
write.move({
  geometryId: string,
  frame: 'world',                     // 目前只支持世界坐标
  units: 'model-native',              // 模型原生单位（元数据不标注单位）
  delta: [number, number, number],    // 每个分量都必须是有限数字，且不能全为 0
}, identity)
// 返回 { geometryId: string; origin: [number, number, number] }
```

- 一次只移动一个几何；ID 不能包含逗号。
- 移动前读取原位置，移动后再读取并比对。
- 引擎可能跳过很小的局部分量，或对位置参数做截断。**返回成功不代表位置一定按请求变化**，请以返回的 `origin` 为准。

### 3. `parameter.set`

```ts
parameter.set({
  owner: 'geometry' | 'crossSection',
  ownerId: string,
  parameterId: string,
  value: number,                      // 必须是有限数字
}, identity)
// 返回 { actual: number }             // 回读到的实际值
```

- 参数必须出现在该所有者的可连接参数列表中，否则拒绝。
- 引擎会拒绝部分参数（例如受限、幂次、不等式关系类参数），具体以引擎代码为准。
- `actual` 是回读的值，可能与请求值不同（例如被范围截断）。

## 七、写入结果与错误

每次写入只有三种结果：

| 结果 | 含义 | 你应该怎么做 |
|---|---|---|
| **成功** | 操作完成，并已回读确认 | 继续 |
| **明确未写入**（`not_written`） | 引擎确定没有修改模型。错误的 `details.outcome` 为 `not_written` | 修正输入后可重试 |
| **结果未知**（`OUTCOME_UNKNOWN`） | 写入可能已经发生，但无法确认 | **不要自动重试**。先用读取接口查看当前状态，再决定 |

常见错误码：

| 错误码 | 含义 |
|---|---|
| `INVALID_ARGUMENT` | 输入或令牌格式不对。大多在本地检查，不发送给引擎 |
| `STALE_MODEL` | 令牌的会话或模型版本已过期 |
| `SESSION_CLOSED` | 句柄已关闭 |
| `GEOMETRY_NOT_FOUND` | 指定的几何不存在 |
| `CROSS_SECTION_NOT_FOUND` | 指定的截面不存在 |
| `ENGINE_ERROR` | 引擎报告错误，或返回数据格式不合法 |
| `OUTCOME_UNKNOWN` | 写入结果无法确认（见上表） |

## 八、能力与协议声明

- `capabilities()`：**接口自己声明**支持哪些功能。写入功能目前标记为 `supported`。
- `protocol()`：向引擎查询它**声明**的操作名称。每次都会重新请求，不做缓存。
- `declaredCapabilities()`：把引擎声明与 v1 需求对照。写入功能目前仍为 `unknown`，因为 v1 协议词汇表里还没有写操作的名字。

**所有声明都只是"说明"，不代表运行正常、安全或已授权。** 例如 `guardedEpochV1` 被声明，并不证明对应接口可用。

<a id="implemented-interface-and-limits"></a>

## 九、限制与不保证的事项

使用前请务必阅读本节。

### 1. 身份令牌不是对象身份

- `modelEpoch` 只在模型被替换时递增（新建模型、读入文件等）。
- 同一版本内，几何可能被删除后重新创建，ID 可能被复用，指向不同的对象。令牌**无法检测**这种情况。
- 在真实浏览器中观察到过：图形界面"克隆 → 替换"后，克隆出的几何 ID 与版本号都没变，类型却从 Clone 变成了 Wing。

### 2. 读取不是快照

- 多次读取之间，模型可能已被修改。
- `wing.get` 与 `fuselage.get` 内部是多次引擎请求，结果可能混合两个状态。

### 3. 读取也会产生副作用

- 引擎读取会消耗全局 OpenVSP API 错误栈。
- 参数枚举会改写参数在内存中的"链接容器 ID"。它用于参数链接和 Snap To，改变后可能影响之后的操作。这一副作用**没有在真实图形界面操作中完整验证**。
- 读取不会修改参数值，也不会产生撤销记录。

### 4. 写入不是事务

- 多步操作（例如连续移动多个几何）中途失败时，已完成的步骤**不会回滚**。
- 没有撤销记录，也没有持久化保证。

### 5. 图形界面与其他入口不受保护

- 守卫只覆盖通过本接口发出的请求。
- 图形界面的操作，以及旧版底层请求（例如 `window.__webvspEngine.request`），仍然可以修改模型，并且不检查令牌。
- 同时在界面里编辑时，写入结果可能与预期不符。

### 6. 脚本引擎的风险未被排除

- OpenVSP 内置 AngelScript 脚本引擎。在**测试构建**中，人为触发的垃圾回收或脚本对象析构曾经删除了另一个几何，而守卫没有报告。
- 这只是有限的测试观察。**它不能证明普通写入一定会触发这种情况，也不能证明不会发生。**
- 因此本接口**没有**脚本隔离保证，**不要用于不受信任的模型**。

### 7. 其他限制

- **无超时**：调用可能一直挂起，直到句柄被关闭。
- **关闭不取消**：句柄关闭后，已提交给引擎的请求仍可能执行；关闭只让之后的新调用失败。
- **不是安全边界**：同源网页脚本可以访问同样的接口。`window.__webvspModelingReadV1` 是只读便利入口，不是授权机制。
- **保存与重开未验证**：写入只发生在浏览器内存中。关闭页面前请在界面里手动保存模型。

## 十、测试与验证

| 层次 | 内容 | 状态 |
|---|---|---|
| 单元测试 | Vitest：前端 37 个文件、513 项，覆盖各服务的逻辑与错误分支 | 通过 |
| 类型与构建 | `tsc -b` 与 `vite build` | 通过 |
| 真实浏览器 | `facade-write-browser-check.mjs`：隔离的 Chromium + 生产 WASM，覆盖机身与机翼的创建、参数设置、移动、回读，以及越界、旧令牌、关闭后的错误 | 通过 |
| 引擎故障注入 | 测试构建中模拟中途失败，检查结果分类 | 通过（仅测试构建，不代表生产） |

**未覆盖：** 图形界面并发编辑、保存与重开、脚本安全、对象身份（ABA）、跨多次请求的一致性。

## 十一、相关文件

- 对外入口：[frontend/src/modeling/index.ts](<frontend/src/modeling/index.ts>)
- 写入服务：[frontend/src/modeling/writeService.ts](<frontend/src/modeling/writeService.ts>)
- 参数写入：[frontend/src/modeling/parameterWriteService.ts](<frontend/src/modeling/parameterWriteService.ts>)
- 只读便利入口：[frontend/src/modeling/browserReadApi.md](<frontend/src/modeling/browserReadApi.md>)
- 浏览器验收脚本：[frontend/src/modeling/facade-write-browser-check.mjs](<frontend/src/modeling/facade-write-browser-check.mjs>)
- 脚本安全威胁模型（设计讨论，未实现）：[wasm/SCRIPT_FREE_THREAT_MODEL.md](<wasm/SCRIPT_FREE_THREAT_MODEL.md>)
