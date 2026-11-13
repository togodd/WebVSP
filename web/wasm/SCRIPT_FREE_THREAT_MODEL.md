# Script-free 隔离：威胁模型与待验证设计

> **状态：仅设计讨论，尚未实现、尚未授权架构或接口变更。** 本文不改变现有 API、GUI、构建配置或运行行为，也不批准任何写能力。它不是实现方案或安全证明，更不能据此直接解封当前 facade 的写操作。任何候选方案、接口、兼容性及部署均须另行审查和授权。

## 目标与边界

讨论未来如何在执行选定建模操作时，证明其整个相关生命周期不受不可信 AngelScript 的同步重入及遗留状态影响；这里的“script-free”是待证明的性质，不是仅检查当前模型树没有 Custom Geom 或 Advanced Link。攻击者可控制导入的模型和其中脚本及名称、调用顺序和失败输入，也可能通过正常 GUI 或现有 raw 路径改变状态。可信假设包括未经篡改的宿主、浏览器/Wasm 运行时、应用代码、编译与发布链；不把同源页面脚本、浏览器控制台或同一引擎实例内的 raw 调用当作隔离域。拒绝或失败后不能假设事务回滚、无副作用、可靠保存、无拒绝服务或无内存安全缺陷。

目前受保护 facade 的 `write.create`、`write.move`、`parameter.set` 仍不可用；底层 guarded 写路径和 GUI/raw 不等同于已隔离的 facade，详见 [现状与限制](../MODELING_API.md#implemented-interface-and-limits)。本文不建议绕过禁用逻辑。

## 已读源码所示威胁入口

- **模型自带代码而非仅显式运行脚本。** [CustomGeom 解码](../../src/geom_core/CustomGeom.cpp#L1032-L1053) 从 XML 恢复脚本内容、调用 `ReadScriptFromMemory` 并初始化；[AdvLink 解码](../../src/geom_core/AdvLinkMgr.cpp#L315-L330) 添加链接并构建脚本，[BuildScript/UpdateLink](../../src/geom_core/AdvLink.cpp#L536-L611) 拼入代码、替换模块并执行。打开和插入均需考虑：[几何解码](../../src/geom_core/Vehicle.cpp#L3473-L3529) 同时处理几何与链接；[读取](../../src/geom_core/Vehicle.cpp#L3629-L3696) 解码后还更新并强制更新链接。并非等待用户点击“运行脚本”才有风险。
- **缓存、启动和构建。** [ScriptMgr 初始化与模块读取](../../src/geom_core/ScriptMgr.cpp#L104-L160) 注册文件系统及广泛 API；[读取实现](../../src/geom_core/ScriptMgr.cpp#L220-L272) 在 guard 之前按内容复用已有模块，新构建可能运行全局初始化器；删除模块可能运行全局析构器。Vehicle 初始化还读取自定义脚本（[Vehicle](../../src/geom_core/Vehicle.cpp#L398-L401)）。一次空模型检查、当前链接列表为空、模块 cache 命中、构建失败或诊断标记为 false 都不能证明 VM 无可运行状态。
- **GC、最后引用释放与间接调用。** [guard](../../src/geom_core/ScriptMgr.h#L65-L82) 只覆盖指定 ScriptMgr 入口，不是 VM 执行屏障；[测试探针](engine/engine.cpp#L1263-L1411) 单独覆盖强制 GC 和 `ReleaseScriptObject`。析构器可从 VM 内调用已注册 API 而不经过 `ExecuteScript`。现有 [建模文档的实验记录](../MODELING_API.md#implemented-interface-and-limits) 报告了限于一次性测试构建的 GC/Release 及 setter 注入观察；不能据此推断普通写必然触发 GC，也不能推断不会触发。仅屏蔽 `DeleteGeom` 的测试代理不覆盖其他 API、GUI 或原生调用。
- **保护范围有限。** [guarded preflight](engine/engine.cpp#L1737-L1792) 检查活动 context、Advanced Link、整个 geom store 的类型及部分创建类型，但源码明确说不是完整屏障；[写 guard 的生存期](engine/engine.cpp#L2309-L2383) 覆盖 preflight、写和后续处理，发生尝试时写已开始可返回 `unknown`，不是回滚。缓存模块和绕过 ScriptMgr 的 VM 入口仍须分析。

## 待审查的隔离生命周期（非选定方案）

1. **建立**：在任何不可信模型或启动脚本被读取、编译、初始化之前建立可信的隔离边界。若依赖新 worker/新 Wasm 实例，必须证明其实际拥有独立 VM、内存、缓存和工作文件，并证明启动路径及注册不先执行不可信代码；仅 `Renew`、清空几何或新建 facade 句柄不足以建立此性质。具体边界与资源成本待决策。
2. **导入**：将模型视作携带代码的数据；候选方案可以拒绝、隔离处理或转换，但必须定义 Custom/AdvLink、includes、缓存、外部资源、未知类型与未知 XML 的 fail-closed 策略以及功能损失。单纯静态扫描或删除可见节点不是完备证明。验证应覆盖构建全局初始化、后续更新与隐含调用。
3. **部分失败**：导入可能在解析、创建部分对象、构建模块、初始化、更新及清理阶段失败；错误返回不能证明无执行或无状态残留。[ReadXMLFile](../../src/geom_core/Vehicle.cpp#L3629-L3696) 在解析前提升 epoch，后续原地解码和更新，不能由此推断原子性。对于插入和失败重试同样要分析；候选设计应在可观察副作用前隔离、失败后销毁或永久污染隔离实例，未经证明不能复用或对外发布中间状态。GUI、文件句柄及外部输出若已发生副作用也不能凭销毁实例声称撤销。
4. **运行**：仅在完整证明的边界内接受定义明确的操作，覆盖写前、写中、回读、watch、嵌套调用及异常；禁止隐含脚本入口和来自 GUI/raw 的并发或重入，或者证明它们共享同一完整仲裁机制。未能判定时失败关闭；写已启动、结果丢失或析构期间失败时结果应为未知，不能自动重试或声称未写。
5. **销毁**：停接任务、处理排队及在途结果，隔离 teardown 中的 GC、引用释放、模块销毁和析构器；销毁完成前不得把旧状态当作干净资源重用。异常、终止及浏览器崩溃时定义失败语义与外部副作用范围。禁止以 guard 尝试标记未设置证明 teardown 无脚本。

## 身份与 ABA：独立问题

即使将来证明 script-free，也不能因此得到对象身份或并发安全。[模型 epoch](../../src/geom_core/Vehicle.cpp#L916-L938) 在 Renew 和 [ReadXMLFile](../../src/geom_core/Vehicle.cpp#L3629-L3633) 增加，溢出失效；它不是每次编辑或每个对象生命周期的世代。[现有说明](../MODELING_API.md#implemented-interface-and-limits) 记录了同 epoch 的插入、删除和对象替换，以及同 ID 替换的限制；[测试夹具注释](engine/engine.cpp#L1413-L1419) 也明确指出 epoch、指针、名称和 ID 无法防 ABA。

若未来需要陈旧对象拒绝，须另行设计独立的对象生命周期世代及实例/session 身份：覆盖创建、删除、替换、clone、ID 转移/重用、导入部分失败及溢出，校验和使用在同一所有者线程内原子完成；不得复用 watcher revision、模型 epoch、地址或名称替代。对象世代仍不提供跨多个请求的快照、事务或回滚。对公开 token、兼容性和所有变更入口的覆盖均未获批准、未实现、待证明。

## GUI、raw 与信任边界

[页面 bridge](../frontend/src/api/wasmEngine.ts#L178-L206) 和 [raw 路由、控制台及 mirror 事件](../frontend/src/api/wasmEngine.ts#L214-L293) 是不同入口；[engine allowlist](engine/engine.cpp#L1648-L1661) 限制 guarded 入口而不封锁普通入口。GUI 原生回调和现有 raw 操作可在同一实例改变模型，不能因为 facade 禁用写而视为授权隔离。未来方案必须明确哪些入口被纳入、拒绝或放在独立实例，定义排队顺序和 UI 状态同步；不依赖前端隐藏按钮作为安全控制。

## 测试宏、生产与工具链信任

`WEBVSP_SCRIPT_GUARD_TEST`、`WEBVSP_PARM_REENTRY_TEST`、`WEBVSP_DELETE_GEOM_PROXY_TEST` 是诊断/故障注入用途，不得进入生产或用用户模型运行；三宏代理只改变特定脚本绑定。[构建说明](README.md#production-compile-guard)、[测试配置](tests/production_guard/run.cmake#L57-L126) 和 [engine 构建](engine/CMakeLists.txt#L36-L57) 展示部分检查及隔离测试构建要求：宏即使定义为 `0` 也可能被 `#ifdef` 视为存在。检查不能抵抗被篡改的编译器、构建规则、宏重定义或旧产物。

[工具链](toolchain.cmake#L10-L25) 依赖环境中的 EMSDK；[CI](../../.github/workflows/pages.yml#L28-L30) 指定版本并使用缓存与外部安装。版本固定不是供应链完整性证明。验收需可信来源及工具链/依赖、构建脚本和缓存的完整性与来源记录，隔离测试/生产构建目录，检查实际编译命令、宏、链接与最终部署产物，防止旧或测试 artifact 混入；这些均不是本文已验证的事实。

## 验收门槛：全部待证据，非解封清单

- 明确威胁边界、所有入口清单和经审查的架构；证明启动、缓存命中/未命中、模块构建失败/全局初始化、更新、GC、Release、模块丢弃及 teardown 都不会穿透隔离。
- 真实引擎及浏览器中用固定无害夹具、一次性实例测试 Custom/AdvLink 的打开、插入、重复加载、失败/部分导入、重试和清理；包括异常、终止、嵌套与异步在途结果，检查外部副作用及不可恢复状态。不以模拟测试或成功返回替代证据。
- 分别测试 GUI、raw、直接导出和 facade 的互扰，生产构建无测试入口；核对不同构建及实际发布 artifact。测试必须有正反对照，覆盖目标浏览器和工具链，并记录版本、命令、夹具、结果和限制。
- 独立验证对象世代/ABA、防溢出、跨会话和所有结构变更；验证操作语义、错误/未知结果、读回、GUI 一致性与保存重开。对不能证明的路径保持禁用。
- 以上结果、残余风险和兼容性须独立评审并由授权方决定后续；满足部分测试或新增本文均不构成解封授权。

## 本次核对范围

本次仅静态阅读本文链接的相关源码和现有说明，区分源码可见行为与文档记载的历史测试观察；未执行测试、编译、浏览器复现、依赖/产物检查，也未穷举所有 AngelScript、GUI、原生调用或模型输入路径。因此本文不是完整审计或安全认证，现有文档所述实验结果未在本次重新验证。
