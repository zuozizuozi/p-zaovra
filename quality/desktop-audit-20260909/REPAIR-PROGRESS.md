# 修复进度（持续更新）

目标仍是完整修复审计问题并验证正常商业使用链路；后续实机复核发现的问题也持续纳入 REPORT.md，以下按批次记录，不是缩小后的交付范围。

## 第一批已落地

- #1：新增 server-event 统一 V2 审批/提问事件适配，放在 SSE 分发前，覆盖所有订阅者；Session store 的直接事件入口也适配。覆盖 permission 字段转换、事件重放去重、回复/拒绝清理。
- #2：共享 Electron session 只安装一次权限处理器；按仍存活的已注册 renderer 验证。新增双窗口、关闭其中一个窗口、陌生 renderer、空 sender 和非可信 URL 测试。
- #3：保留 Session.revert，revert staged/cleared/committed 事件使会话信息重新同步。
- #4：取消在找到父 user 之前只允许四页的截断，新增跨五页后找到 user 的历史测试。仍需进一步检查跨页旧回合、巨大历史的性能和完整浏览器行为。
- #6：排队项发送时传入已有稳定 item.id，避免手动重试重新分配 ID。仍需配合持久队列的完整重试测试。
- #7：diff 从 Session 解析目录并随请求传递。
- #10：Windows 首次启动读取 process.argv 中的协议链接。仍需安装版冷启动/热启动验收。

以上是代码与局部验证进展，不代表整项生产验收完成。#5 持久队列/drain 状态、#8 上一轮变更、#9 命令 agent/model/subtask、#11 翻译仍待完成。

## 当前验证

- desktop-app typecheck 通过；75 单测通过。
- app-ui typecheck 通过；test:unit 579 通过、1 失败（原有翻译键缺失尚未修复）；test:browser 30 通过（HappyDOM）。
- 审计五项复现从 0/5 变为 5/5 通过。
- 相关会话、事件和首页索引测试 31/31 通过。
- 一次误用 `--conditions=browser` 运行原本的 src 单元测试，导致 Bun 对 Solid proxy 数组的 toMatchObject 不兼容；按包的 test:unit 运行环境重跑全部通过，未改业务逻辑绕过断言。
- 生产压缩构建的适配器基准：1001 条消息、100 样本，中位数约 0.0666ms → 0.0629ms，p95 0.2594ms → 0.2615ms。属于适配器局部测量，不能代表 UI 性能。
- 完整生产 UI 基准构建通过，但旧 mock-server 缺少 V2 路由，收到 HTML 后显示加载错误，没有采集到浏览器性能指标。需修复 fixture、重跑并补充真实 UI 回归；不得将此基准记为通过。
- 审计专用 Playwright config 使用本机已安装的 Chromium 1228。尝试下载安装 1217 长时间停滞，已终止该下载进程；未重启用户 app/server。
- 现有用户 Electron 主进程未重启，故新增主进程代码尚未进入该运行实例。原窗口此前被复现触发的 denied 权限状态仍未恢复。

## 下一步

### 第二批：执行状态

- #5 的忙闲状态部分已落地：step.ended/failed 不再直接设 idle；使用现有 session.wait 等待整个 drain，再以 session.active 确认所有权。若已有后继 drain，则继续等待。重连初始化中的 busy session 也建立等待。
- 等待接口失败但 active 仍存在时保留 busy，错误退出当前等待，避免失败请求形成紧密循环；后续事件/重连可再次协调。
- 新增两项测试：连续 drain/工具轮次之间保持 busy，等待失败不误报 idle。Session store 11 项测试通过，类型检查通过。
- 全套单元测试一轮为 580 pass / 2 fail：翻译缺失仍失败，另外 observe-element-offset 时间敏感用例失败；随后该文件与会话测试合跑 18/18 通过。后者暂记为待观察的测试抖动，未声称全套已绿。
- 持久队列的编辑/取消仍缺服务端生命周期接口，不能仅把发送改为 queue 然后让 UI 的“编辑”静默失效；需继续完成服务端输入生命周期与前端对接。这部分尚未实现。

### 第三批：持久取消基础

- 新增 SessionInput.cancelledSeq 及增量数据库迁移，保留原 admission 记录作为重试依据；pending 查询及提升逻辑排除已取消输入。
- 新增 durable `session.next.prompt.cancelled` 事件和 projector；取消与提升竞争时只有一个状态获胜，取消项不会变成可见 user 消息；跳过竞争中取消的队首后继续寻找下一项。
- 新增 SessionV2.cancelInput 及 `POST /api/session/:sessionID/input/:messageID/cancel`：重复取消返回同一记录，缺失/跨 Session/已提升输入返回冲突；取消后的旧 prompt 重试不会重新 wake。
- 运行了 `packages/client` 的 generate 和 legacy SDK build；所有生成产物来自工具，未手改。
- 核心新增取消、重复取消、旧请求重试、已提升拒绝、并发提升、事件重放测试。Session prompt 29/29 通过，数据库迁移测试此前 16/16 通过，迁移生成一致性检查通过；Core/Server/Client/App UI 类型检查通过。
- Desktop store 已处理取消事件，清理此前可能显示的待处理消息并重新同步。**队列 UI 的持久提交、恢复、编辑及“立即发送”仍需接入上述接口，不能宣称 #5 已完成。**
- 运行中的用户 sidecar 未重启，新增服务接口尚未进入该进程；后续端到端测试需使用隔离测试实例或真实 handler 的测试运行时。

### 第四批：队列 UI 接入

- sendFollowupDraft 增加 delivery/resume，队列以 `queue` 提交且不乐观插入 user message、不改 busy；重试沿用同一 ID。
- ServerSession 新增 pending_input，冷加载保留队列而不将其冒充正式 user turn；promoted 事件移出队列，cancelled 清理，缓存驱逐也清理。
- 桌面从服务端 pending_input 恢复队列草稿及附件；本地保留未确认发送项。新队列立即 admission，不再等当前页面观察到 idle。
- 已 admission 项编辑前先取消；本地失败项先以同 ID/resume:false 核对 admission 再取消，避免响应丢失后留下后台任务。立即发送采用取消原 queued input + 新稳定 ID 的 steer，保存转换中的 ID 以供失败重试。
- 新增队列冷恢复/正式提升状态测试，以及实际 SDK→HTTP fixture 的稳定 ID/queue/无乐观 user/无 busy 写入测试。类型检查通过；相关状态与提交测试 19/19 通过，HTTP fixture 1/1 通过。
- **仍需真实浏览器队列流程、并发点击/页面生命周期回归与恢复验证，不能把局部测试视为 #5/#6 完整验收。** 队列当前仍使用 Session 的 agent/model 切换机制，需在后续命令/模型语义核对时检查排队期间配置变化影响。

### 第五批：上一轮变更

- 新增 SessionTurnDiff，以数据库中 user 消息序号确定起点/下一条 user 确定终点，选择本轮已完成 assistant 的第一 start 与最后 end 快照，限制到本轮记录的文件集合。
- SessionV2/Protocol/Server 新增 turnDiff 接口；采用 Session 的 Location 加载 Snapshot，返回结构化 patch。Client 与 legacy SDK 均重新生成。
- UI turn 模式从新接口读取，不再依赖未填充的 user.summary.diffs；按会话、用户消息及最后助手完成状态更新 query，错误会提示。
- 持久事件→数据库→轮次范围测试通过（含多步、去重、下一轮隔离、缺失消息）；Session prompt 30/30 通过。真实 Git Snapshot 4/4 通过；Core/Server/App UI 类型检查通过。
- 没有可用完成快照时返回空列表（沿用 snapshots 可禁用/捕获失败的能力边界），仍需实际 UI 验收与不可用态体验检查。未将局部范围测试+Snapshot 测试冒充完整端到端通过。

### 第六批：命令选择配置

- Slash command 的 agent/model 现在优先于输入框的默认选择，实际 switch 请求和 optimistic message 使用相同配置；显式命令模型不继承之前模型的 variant。
- 命令解析支持换行参数，模型 ID 保留 provider 后的完整 slash 路径；缺少 provider 或 model 的配置拒绝发送。
- 实际 SDK→HTTP fixture 验证了 command agent、完整 model ID、variant 清除和换行 template 展开。App UI 类型检查及该发送测试通过。
- **subtask 尚未实现，#9 未完成。** 当前 HTTP create 不能直接创建 parentID 子会话；应通过服务端的子任务执行语义解决，不能在 UI 里忽略 subtask 或伪造普通会话。
- 队列仍会在 admission 前切换 Session agent/model。已定位 runner 在 promotion 前读取 Session，因此完整修复需要把每条输入的执行配置持久化，并在安全 promotion 边界生效；不能只删除 UI 切换请求而丢掉用户选择。

### 第七批：每条输入的持久执行配置

- Prompt/Input/User 增加可选 selection（agent/model/variant），兼容历史无 selection 的记录；admission 时持久保存，精确重试也核对 selection。
- Prompted projector 在安全提升边界应用配置，UI 不再在排队 admission 前请求 switchAgent/switchModel。历史和待处理输入按各自 selection 恢复显示。
- Runner 在提升前初始化所选 Agent 的系统上下文，提升后重新读取 Session 决定实际模型，保留系统上下文暂不可用时不消耗 pending input 的原语义。
- Core 117 项 prompt/runner 测试全部通过，包含排队时不改变活动 Session、配置冲突重试，以及连续两条队列分别调用各自模型；Core/App UI 类型检查通过。两套 Client 由规定命令重新生成。

### 第八批：翻译与浏览器验证入口

- 补齐 15 个非中英 locale 的 21 项服务商发现提示，共 315 条翻译；语言键与占位符检查 4/4 通过。
- App UI 单元测试 583/583、HappyDOM 浏览器测试 31/31 通过。HappyDOM 结果不等同于真实 Chromium 验收。
- 旧浏览器 fixture 补充 V2 session/message/pending/todo、command、MCP 和独立测试账户的 console 状态响应，沿用原场景数据转换为 wire shape，以便生产 UI 实际走 V2 adapter。生产登录门禁未修改，测试使用虚构组织。E2E 类型检查和 fixture 的分页/延迟测试通过。
- 生产构建的 Chromium 首次导航基准 3/3 通过（已有任务、新任务页、子任务）；空白帧与未知帧采样均为 0。原始输出保存在 `performance-navigation-baseline.txt`。这只是导航基准，不包含真实模型/服务端执行验收。
- Server、Client、Desktop 类型检查通过。

### 第九批：历史分页的跨页边界

- 新增两项真实 store 复现：跨页的助手回复因缺少该轮 user 被丢弃；向前翻页时错误使用较新的缓存 user 作为 parent。修复前两项均失败。
- 缓存 parent 必须在当前页最早消息之前；跨页暂无法关联的 assistant 保留在对应 cursor 下，读取上一页后再关联，缓存驱逐时清理。
- 两项回归转绿，会话 store 14/14、全套 App UI 单元测试 585/585、App UI/E2E 类型检查通过。
- 修复后重新生产构建并跑导航基准，3/3 通过且无空白采样；输出保存在 `performance-navigation-after-pagination.txt`。这是小样本场景完成/渲染检查，不用于宣称普遍性能提升。
- 队列进一步移除新增时的重复主动发送入口，由 effect 串行 admission；effect 跳过已 admission 项，避免服务端已有队首阻挡后续本地输入。立即发送的草稿转换与 mutation 启动合并为 batch。类型检查通过，仍需完整队列交互回归。
- 队列调整后再次生产构建和 Chromium 导航测试 3/3 通过，原始输出 `performance-navigation-after-queue.txt`；最初五项审计复现测试再次 5/5 通过。未以导航测试替代队列功能验收。

### 第十批：子任务配置与卡片结果契约

- TaskTool 接受可选 model override，并将其及 variant 持久化到子输入 selection；无 override 时保留既有行为。TaskTool/恢复 7 项测试和 Core 类型检查通过。
- 新发现 #12：后端 task_id 未适配为 UI 卡片读取的 sessionId。增加保留原结果的字段适配，实际 V2 形状回归从失败转绿。
- 浏览器 fixture 的 task 返回也转换为 task_id，移除旧 sessionId，确保生产 UI 必须通过真实 adapter 才能导航。重新生产构建，首次导航 3/3 通过（含点击任务卡片进入子任务），原始输出 `performance-task-link.txt`。
- App UI 586/586 单测、App UI/E2E 类型检查通过。命令 subtask 调度尚未实现，不将 TaskTool 基础能力和已有子任务卡片导航视为该功能完成。
- `specs/v2/config.md` 的早期评审曾描述不迁移命令字段，但当前 ConfigCommandPlugin、内置 review 和公开 schema 已实际暴露这些字段；以当前软件行为为依据保留 #9，不能借旧规格删除问题。

### 第十一批：命令子任务调度

- Prompt/Input/User 增加持久 subtask 描述（命令、目标 Agent、模型）。前端将父会话 selection 与子任务配置分离，队列冷恢复保留 subtask；附件和 Agent 引用也传入子任务。
- Runner 对尚未处理的命令生成稳定 tool call ID，走现有 durable tool publication/settlement/interrupt 路径，然后继续父会话；不先调用模型决定是否创建子任务，也不将该委派计入 provider-turn allowance。
- TaskTool 验证命令仍为已配置的 subtask、Agent 与命令配置一致；允许这种明确命令在独立子会话使用 primary Agent（覆盖内置 review 未指定 subagent 的情况），保留普通 task 只能委派 subagent 和禁止嵌套的规则。
- Core prompt/runner/task/recovery 126 项测试通过，覆盖先委派后父会话 provider、显式恢复不重复委派、primary 命令与无效命令。SDK→HTTP 测试验证父子配置分离。此处 runner 的 task 执行结果使用测试注册工具，尚非真实父子两次 provider 的端到端证明。
- 两套客户端已按规定重新生成；Core/Server/App UI 类型检查、App UI 586 项单元测试通过；生产构建与 Chromium 导航 3/3 通过，输出 `performance-command-subtask.txt`。
- TaskRecovery 查询补上 cancelled_seq 过滤，已取消子输入不再进入恢复唤醒名单，实际数据库回归通过。
- 仍需处理/验收：编辑已恢复的排队命令时保留其命令语义（当前编辑草稿仅恢复文本/上下文）；真实 /review→子会话执行→父会话结果的完整集成，以及取消/中断边界。

### 第十二批：真实子会话与排队命令编辑

- 增加使用实际 TaskTool.run、SessionV2.create/prompt/resume 和数据库投影的集成测试，确认实际 parentID、先子模型后父模型、子结果进入父请求、恢复不新增第二个子会话。仅 provider 响应和权限决策受控；不是桌面 UI/远程供应商端到端测试。
- Prompt/Input/User 保存可选原始 invocation；模型继续使用展开后的 text，时间线和待处理项使用原始命令。两套 Client 已重新生成。
- 编辑草稿携带原 Agent/model/variant，两种输入框恢复这些选择；原始命令从待处理记录还原，避免编辑 /review 后变成普通文本。
- SDK→HTTP→pending adapter→编辑草稿→SDK 的回归验证重提后的展开文本和子任务配置保持一致。
- 抽出 cancelFollowupDraft 处理失败的 queue→steer 转换：先取消原项，再以 resume:false 核对替代项并取消；已取消 admission 的重试允许完成编辑，普通发送仍拒绝复活。HTTP 回归核对调用顺序和 resume:false。
- Core 127 项、App UI 586 项、HappyDOM 浏览器 31 项测试通过；Core/Server/Client/App UI 类型检查通过。生产构建后的导航复核 `performance-command-edit.txt`、最后取消修复后的 `performance-queue-cancel.txt` 均为 3/3 通过。导航测试不替代队列功能的真实交互验证。

### 第十三批：提交冻结、生产打包与实机复核

- 队列项保存首次构建的 admission payload，服务端恢复项保留原 payload；立即发送转换沿用内容，编辑后才重新展开命令。命令模型 variant 从 V2 adapter 经 CommandView 保留到提交。
- SDK→HTTP 回归让服务端收下请求后主动断开连接，再修改命令模板/Agent/模型；重试的 ID 和完整 payload 与首次一致。文件 MIME 也保留。
- 正式渠道构建、Desktop 75 项测试、package:check 通过。默认 Electron 下载路径因请求超时失败，日志 `desktop-package.txt`；改用机器上已有的同版本 42.3.3 运行时后 NSIS 打包成功，日志 `desktop-package-local-runtime.txt`。未执行安装/卸载或发布，不宣称签名验收通过。
- 在隔离 profile 的打包版中，主进程/内嵌服务启动成功；打开第二窗口后第一窗口 clipboard-write/notifications 权限均仍为 granted。
- 官方账户仅使用浏览器驱动注入的本地测试响应，产品代码未绕过登录。受控本地模型完成普通任务、执行中 steer、问题选择与提交、命令实际创建子会话并返回父会话结果；所有模型流量均指向本地 fixture。
- 原生项目选择对话框能打开，但窗口自动化的几何/UIA 能力报错，未完成文件夹选择验收。后续通过真实 HTTP 在隔离目录创建 Session；不是原生打开项目全流程通过。
- 新发现 #13：有效 V2 配置被桌面旧读取接口拒绝，且无效配置错误被缓存；尚未修复。使用全新目录的兼容配置继续验证。
- 新发现 #14：设置层强制 queue→steer，已恢复选项；新发现 #15：空历史刷新 limit=0、长历史超过 100 导致 400，已修复并补 2 项 store 回归。
- 最新 App UI 588 单测、31 HappyDOM 测试、类型检查通过；生产 Chromium 导航 3/3 通过，输出 `performance-history-limits.txt`。这是导航检查，不代替新的队列交互验收。
- 首个 NSIS 文件不包含随后 #14/#15 修复；最新源码正在生成 `windows-package-next` 供独立复核，不能将旧安装包视为最终交付。

### 第十四批：队列实际交互、长 ID 路由及配置错误恢复

- 继续发现设置初始化 effect 强制 queue→steer，且 OC-2 设置组件独立于经典设置。移除强制改写，并为两种设置界面提供排队选项。
- #16：三处实际 HTTP 服务入口设置 maxParamLength=1024，覆盖确定性子会话及输入长 ID，保留现有 ID 与精确重试语义。未改公共 HttpApi 定义。
- #13 的错误恢复部分：初始化失败时，在移除 InstanceStore 入口前清理该目录的 InstanceState。实际配置回归先失败，修复后通过；避免缓存错误永久阻挡重试。V2/旧配置格式兼容部分仍未修复。
- Bootstrap/InstanceStore/V2 HTTP 18 项测试全部通过（`bootstrap-and-long-id.txt`）。原有 SSE 测试仍调用旧 `/session` 和旧 `session.created`，已更新为实际 `/api/session` 与 `session.next.created`。Zaovra/App UI 类型检查通过。
- 新生产构建和独立 unpacked 包通过，日志 `desktop-prod-build-recovery.txt`、`desktop-package-recovery.txt`；路径 `windows-package-recovery/win-unpacked/Zaovra.exe`。该包仅供隔离验证，未生成最终 NSIS，也未发布。
- 实际 OC-2 设置选择“排队”，本地受控模型保持前一任务执行，提交 `/inspect queue-original` 后出现持久队列；编辑会取消原 admission、恢复命令，使用正常键盘选中并替换后提交 `/inspect queue-edited`。HTTP pending 确认 delivery=queue、原始 invocation 与展开文本及子任务配置一致，见 `packaged-queue-pending.json`。
- 放行前一任务后仅修改后的命令进入可见历史，pending 为空；实时任务卡片直接进入长 ID 子会话并显示子模型结果，无需刷新。证据 `packaged-queue-completed.json`、`packaged-queue-child.txt`、`packaged-queue-child.png`。浏览器驱动 fill 在已有富文本上追加的情况用真实 Ctrl+A/Backspace/type 重做，未把驱动行为列为产品缺陷。
- 新打包版同一目录先读取 malformed config 返回 400，修正文件后直接重试返回 200，无需应用重启；见 `packaged-config-before.json`、`packaged-config-after.json`。

### 第十五批：桌面智能体列表与 V2 执行器统一

- 桌面 bootstrap 从旧 `/agent` 改为实际执行器的 `/api/agent`，避免 V2 自定义智能体与旧列表不一致。只在显示边界适配 name/modelID 等字段，模型 variant、system、隐藏状态与有序权限规则保留。
- 删除不再使用的旧多形状 normalizeAgentList，替换为真实 V2 形状回归。生产浏览器 fixture 同步改为 V2 agent 响应。
- 新增真实 SDK→HTTP 测试：旧路径返回 400，V2 路径返回自定义智能体，确认只请求 `/api/agent`，模型和 variant 进入查询结果。该测试位于 test-browser，避免单测套件其他文件对 SDK 的 module mock 污染。
- App UI 585 单测、32 HappyDOM 测试、类型检查通过，日志 `app-ui-v2-agent.txt`、`browser-v2-agent.txt`。单测数减少来自移除 4 项旧 payload 兼容测试并新增 V2 适配测试，未删减行为验证来消除失败。
- 生产构建成功，Chromium 导航 3/3 通过、无空白采样，见 `performance-v2-agent.txt`。默认 Playwright 缺少指定版本浏览器，使用此前审计配置中的已安装 Chromium 1228 完成验证，未重启用户应用或服务。
- 此批仅统一智能体目录读取；Provider 列表、配置读取与写回的 V2 迁移仍未完成。最新隔离 Electron 包尚不包含本批 UI 变化。

### 第十六批：服务商过滤迁移与配置实际保存

- 新确认 #17：V1 disabled_providers/enabled_providers 和模型 whitelist/blacklist 在迁移中丢失。V2 新增 provider_filter、Provider.filter、Provider.disabled，保留精确 ID 匹配；目录构建完成后应用过滤，避免上层空名单无法恢复被下层提前过滤的条目。
- 回归覆盖停用内置及自定义服务商、服务商白名单与空白名单、模型黑白名单冲突时 deny 优先、上层空 deny 清除旧限制、V2 disabled:false 重新启用。Core 配置/目录/模型解析 51 项通过，见 provider-filters-validation.txt。
- 新确认 #18：项目 PATCH /config 写错 config.json。现优先更新现有 zaovra.jsonc，否则更新 zaovra.json；使用 JSONC 补丁保留注释及未改字段。默认 HTTP 保存并重读、JSONC 优先级与保留内容共 3 项通过，见 config-write-path.txt。
- 新确认 #19：打开 V2 目录后保存配置，旧 Instance 的销毁未使实际 V2 catalog 刷新。完整 HTTP 复现失败，保留为 quality 下独立 config-live-refresh.probe.ts（不混入已通过回归统计），日志 config-live-refresh.txt。该问题未修复，不把停用服务商的端到端流程标记完成。
- Core/Zaovra 类型检查通过；本批未改公共 Protocol 或 Server HttpApi 定义。新字段是 Core V2 配置字段，数据库 schema.json 与之无关，未手改生成文件。
- 本批尚未重建 Electron 包；最新包仍不含第十五、十六批变化。

### 第十七批：真实 V2 缓存刷新与活动提问保留

- 项目及全局配置保存后调用 ConfigRefresh，枚举实际 V2 LocationServiceMap 的键并失效受影响缓存；项目修改按目录包含关系筛选，全局修改覆盖全部已缓存目录。复用 RcMap 的引用计数机制，仍被活动作用域借用的旧环境保留到释放。
- 没有新增 Config.reload 或改写各服务配置读取机制；现有 Permission/Question 进程内 broker 已支持相同 Location 的新服务回复旧服务请求。
- 原失败 HTTP 复现已移回正式 httpapi-config.test.ts 并通过，独立旧 probe 删除，失败日志保留。服务端配置/全局接口及刷新作用范围 7 项通过；权限/提问已有 14 项通过；Core/Zaovra 类型检查通过。
- 新增真实 LocationServiceMap 回归：旧环境发出提问并保持借用，刷新后新环境正常列出和回复，旧等待完成；项目刷新不影响另一目录，全局刷新会更新另一目录。见 config-refresh-validation.txt、permission-question-refresh.txt。
- 第十五至十七批已一起进入新的生产构建和独立 unpacked 包 windows-package-config-refresh；日志 desktop-build-config-refresh.txt、desktop-package-config-refresh.txt。没有安装或发布，没有重启原用户实例。
- 新打包版在隔离目录与本地模型完成两次“提问等待→PATCH 配置→UI 提交回答→任务完成”。使用 Session 返回的规范目录复核时，配置保存前后 pending 都为 1 且 ID 保留；见 packaged-refresh-question-pending.json、packaged-refresh-question-completed.json、packaged-refresh-final-ui.txt/png。
- 在新包内停用 audit Provider，V2 provider/model 列表立即均为 0；清空停用列表后恢复为 1。旧 /provider 读取也确认停用后为 0。见 packaged-provider-disabled.json、packaged-provider-restored.json。
- UI 下拉框却仍保留 Audit model，说明前端缓存/刷新链路仍未完成，不能把本批服务端修复等同于停用设置的完整 UI 验收。
- 测试还观察到 Windows 目录字符串使用不同斜杠时可落入不同 Location 键；实际 UI 回复按 Session 目录正常完成。该路径身份边界需要进一步复核，未作为已修复项。

仍需完成：

1. #13 的 V2/旧配置读取和写回契约，及前端模型目录的刷新；#19 服务端已修复并通过活动提问验证。复核 Windows 目录身份归一化。
2. 真实权限审批、工具编辑与 turn diff、撤销/重做、中断恢复、双项目、重启持久恢复的完整桌面链路。队列编辑/取消原项已验证，仍需网络故障与重启组合场景。
3. 原生打开项目、最终安装包及安装/升级等交付验收；已通过生产构建和隔离 unpacked 运行，不等于全平台或签名验收通过。
4. 逐条核对审计完成条件，未获得全范围证据前保持目标进行中。官方 API 尚未接入仍不计为缺陷。

### 第十八批：Windows 目录查询缓存与模型选择器同步

- 确认 Windows 项目缓存使用正斜杠，而配置失效事件可携带反斜杠。bootstrap 使用原始目录组成查询键，导致刷新成功却写入另一份缓存，选择器仍显示已禁用模型。真实 QueryClient 复现先失败，见 query-path-before.txt。
- Provider、Agent、Path、Reference、MCP、MCP resources、LSP 查询统一使用 directoryKey，保留 null 全局作用域和服务器隔离。项目 Provider 返回空列表时不再错误回退到全局 Provider。
- 新增两个路径缓存回归和一个空目录 catalog 回归。588 项单元测试、32 项浏览器环境测试通过；App UI 类型检查通过。见 query-path-suite.txt、query-path-typecheck.txt。
- 生产导航 3 项通过，见 performance-query-path.txt；桌面生产构建及独立 Windows unpacked 包 windows-package-query-path 成功，见 desktop-build-query-path.txt、desktop-package-query-path.txt。
- 独立包 PID 21788 / CDP 9237 / agent-browser session desktop-audit-query 使用隔离账户与 runtime-query-flow。PATCH 停用 audit 后选择器不再列出 Audit model；恢复后 Audit model 重新出现并选中，没有重载页面。见 packaged-query-disabled.json、packaged-query-disabled-ui.txt、packaged-query-restored.json、packaged-query-restored-ui.txt/png。
- 本轮未更改或重启用户原 app/server，也没有安装或发布。官方 API 未接入不计作缺陷。
- 后续仍需处理 Agent bootstrap 的 ensureQueryData 缓存重读语义、V2/旧配置兼容、Windows 后端 Location 身份及完整工具/恢复/交付验收；本批不代表全部目标完成。

### 第十九批：Agent 缓存刷新与后端 Location 目录键

- Agent bootstrap 使用 ensureQueryData 导致刷新时沿用旧 Agent 列表。正式 bootstrap 回归预置已删除 Agent，旧实现失败（agent-refresh-before.txt），改用 fetchQuery 后通过。588 单元 + 32 浏览器环境测试、App UI 类型检查通过。
- 真实 LocationServiceMap 复现同一目录正反斜杠或末尾分隔符不同会创建两个 Question 环境，见 location-path-before.txt。现在 get、contextEffect、invalidate 均在入口按当前宿主 path.resolve 规范化目录，保留 workspaceID；不做大小写折叠或 symlink realpath 合并。
- 扩展实际环境测试验证两种路径共用服务、Layer get 同样归一化、配置刷新后另一种路径能回复旧 pending、按另一种路径 invalidate 生效、其他目录不受项目刷新影响。
- 配置 HTTP/环境刷新 5 项通过（location-path-validation.txt）；扩展后的环境及 V2 HTTP/SSE 5 项通过（location-http-validation.txt）；Core Location/权限/提问 22 项及会话 prompt/runner 119 项通过。Core/Zaovra 类型检查通过。
- 本批未变更公共 Protocol/HttpApi 定义，不需重新生成客户端。仍需新版打包运行验收，以及 #13 原生 V2 与旧配置读写契约、工具修改/权限/撤销/故障恢复和交付检查；目标保持进行中。

### 第二十批：独立打包版真实提问、工具审批与撤销恢复

- 第十九批构建已生成新的独立包 windows-package-location，PID 45936 / CDP 9238 / agent-browser session desktop-audit-location。原用户实例未重启或修改。
- runtime-location-flow 在任务等待提问时，使用正斜杠加末尾分隔符调用读取和 PATCH 配置。保存前后 pending 均为 1、ID 相同、保存 200；界面提交后生成 AUDIT_OK 并恢复输入框。见 packaged-location-question.json、packaged-location-completed-ui.txt/png。
- 新增仅本地的受控模型夹具 runtime-tools-provider.ts（端口 58334，Bun session 8539），通过真实模型流产生 write 工具调用；使用 runtime-tools-flow 隔离目录，permission.edit=ask。
- UI 发起任务后出现“拒绝 / 始终允许 / 允许一次”。审批前 audit-result.txt 不存在；点击允许一次后才写入预期内容，工具完成并继续生成 AUDIT_EDIT_OK。见 packaged-tool-permission-ui.txt、packaged-tool-completed-ui.txt、runtime-tools-provider.log。
- 实际审查面板显示 audit-result.txt 的 +1 行及预期内容。点击“重置到此点”后该文件不存在、消息回滚、审查文件数由 2 变 1；展开回滚消息并点击“恢复消息”，文件内容和回复恢复，审查刷新回 2 个文件。另一个文件是夹具 zaovra.json。见 packaged-tool-review-ui.txt、packaged-tool-reverted-ui.txt、packaged-tool-restored-ui.txt/png。
- #13 仍未解决：旧配置读取严格按 V1 schema 解码，项目和全局写入也验证 V1；Core 的 isV1 对混合配置可能选择 V1 转换。不能通过丢弃 V2 原生 Provider 或压缩有序权限规则来绕过，需要保持读写语义的正式方案。本批未实施有损兼容转换。
- 仍需配置契约修复、单轮 diff 专门接口/会话审查视图、故障与持久恢复、双项目/多窗口、最终安装升级验收。已验证的受控模型链路不等于所有真实模型及交付场景通过。

### 第二十一批：混合配置不再静默丢弃 V2 数据

- Core 原本只要发现任一旧版专属键，就把整份文件按 V1 解码并迁移；providers、commands、permissions 等 V2 专属字段会被忽略，混入 V2 MCP/skills 还会使整份配置无效。新增正式配置文件回归先失败，见 config-mixed-before.txt、config-shared-before.txt。
- 现在按顶层字段及共享字段的结构分类：V2 专属字段直接保留，共享字段经严格 V2 字段 Schema 判别，其余由旧 Schema 校验并迁移。最终整体通过 V2 Schema 校验。Provider、Agent、Command 名称表合并；同名条目以显式 V2 定义为准，原生权限数组保持顺序。没有新增依赖或把 native Provider 转成旧 SDK。
- 实际配置文件测试覆盖旧 disabled_providers、旧 Provider、native Provider、有序权限、V2 命令、V2 MCP、V2 skills 同时存在。Core 全部配置测试 58 项通过，Core 类型检查通过。
- 完整默认 HTTP Server 读取 /api/provider 的新增回归确认混合配置下 V2 AISDK Provider 可见；配置 HTTP 5 项通过，Zaovra 类型检查通过。见 config-mixed-validation.txt、config-mixed-http.txt、config-mixed-typecheck.txt、config-mixed-zaovra-typecheck.txt。
- 本批尚未进入新的桌面包。#13 尚未整体完成：旧 /config、/provider 等读取仍严格依赖 V1，项目/全局配置写回也仍需保持 V2 原文语义的改造。不得把 Core 读取修复标记为桌面设置全链路已验收。

### 第二十二批（进行中）：统一保存校验，完整 HTTP 用例仍暴露旧初始化阻碍

- 将 Core 的混合配置解码提取为 Config.decode，同一实现继续供 Config 文件读取使用；Core 配置 58 项仍通过。
- 新增 ConfigParse.configuration，拒绝不属于 V1/V2 的顶层键，并使用 Core.decode 校验合法值。项目 update 在原始 JSONC 补丁后使用该校验，以保留原生 V2 字段；Zaovra 类型检查通过。
- 将现有混合配置 HTTP 测试扩展为实际 PATCH 保存、原文件字段对比和刷新后的 V2 catalog 检查。该测试目前失败：PATCH 返回 400，原因是 InstanceBootstrap 在保存逻辑之前执行旧 Config.get()，旧读取仍拒绝 V2 字段。日志 config-native-save.txt：4 pass / 1 fail，此失败是尚未完成 #13 的正式验收用例，不能报告本批全绿或保存链路完成。
- 当前工作树包含这一明确已知失败用例，下一步必须修复旧初始化/读取与配置表示契约；不要删除或弱化断言来获得通过。现有桌面包尚不含本批与第二十一批修改。

### 第二十三批：配置更新脱离旧项目启动，HTTP 保存与错误恢复通过

- InstanceContextMiddleware 对已认证并完成工作区路由的 PATCH /config 仅解析项目上下文，不执行 InstanceStore.load/bootstrap，因此保存不再被待修复配置或插件初始化阻断。其他请求保持原初始化链路。
- 配置保存后的实例销毁显式针对该目录当前缓存实例；默认按上下文身份销毁的保护仍保留。补充先打开 /config 再 PATCH 的回归，避免临时控制上下文导致缓存未失效。
- 第二十二批已知失败正式用例现在通过：混合 V2 文件 PATCH 返回 200，原有字段全部保留，disabled_providers 生效后 V2 catalog 隐去对应 Provider。
- 新增真实错误恢复：username=42 使 GET /config 返回 400，PATCH 修正为字符串返回 200，随后 GET 成功且值正确；没有重启实例进程。
- 配置、实例上下文、实例路由认证、工作区路由共 25 项通过，见 config-control-validation.txt；Zaovra 类型检查通过。此前配置+项目初始化组合 10 项亦通过。
- #13 的保存部分完成服务端回归，原生 V2 的旧 GET /config、/provider 等读取兼容仍未完成；全局写回仍使用旧校验，需继续处理。新版生产包仍待本轮后重建和实际验证。本批未更改公共 Protocol/HttpApi 定义。

### 第二十四批：全局配置保留原文写回

- 全局 JSON/JSONC 更新统一使用原始文本补丁和 ConfigParse.configuration 校验，避免先按 V1 解码再序列化导致拒绝或丢弃 V2 字段。
- 全局更新仍返回旧 Config 响应格式。原生共享字段无法映射到该格式时只确认已接受的请求补丁；不会把这种响应投影写回源文件。桌面调用只使用更新成功信号并重新读取数据。
- 新增完整 HTTP 测试，分别覆盖 zaovra.json 和 zaovra.jsonc：改变 autoupdate 后 native Provider 配置、有序权限数组、MCP、skills 与注释均保留。测试使用 preload 隔离的临时全局目录，完成后恢复原文件。
- 配置 HTTP 8 项通过，见 global-native-validation.txt；ConfigRefresh/认证 10 项通过，见 global-config-refresh-validation.txt；Zaovra 类型检查通过。
- 正在构建 desktop-build-config-control，包含第二十一至二十四批。旧 GET /config、/provider 等原生 V2 读取兼容仍未完成，不能将全局写入成功等同于设置页全流程已恢复。
- 补充：desktop-build-config-control 已成功完成；尚未生成本批新的 unpacked 包或安装包。

### 第二十五批：桌面模型目录读取实际 V2 执行器

- loadProvidersQuery 改为并行读取 V2 provider/model/integration；新增 provider-catalog 适配 UI 模型数据。可选模型以执行器可用列表为准，Integration 提供未连接服务商的发现入口；不再依赖旧 /provider 成功。
- 新增真实 SDK/HTTP 回归：旧接口返回 400 时仍可列出 native 模型；禁用/废弃模型不进入可选项；连接发现、图片/PDF/工具能力、价格、变体和上下文限制正确映射，未知发布日期保留为空；三个请求均携带正确 location。
- UI 单元测试 588 项、浏览器环境 33 项通过；App UI 与 E2E 类型检查通过；基准服务夹具 2 项、生产导航 3 项通过。见 provider-catalog-validation.txt、provider-catalog-typecheck.txt、provider-catalog-e2e-typecheck.txt、provider-catalog-fixture-validation.txt、performance-provider-catalog.txt。
- 已重新构建并生成 windows-package-provider-catalog，包含第二十一至二十五批。独立实例 PID 50836 / CDP 9239 / agent-browser desktop-audit-catalog，目录 runtime-native-catalog-flow 使用原生 providers 配置，模型通过本地 61661 服务提供。
- 打包版下拉列表实际出现 Native audit model，手动选择后发送任务，正常完成 AUDIT_OK；见 packaged-native-catalog-ui.txt/png。原用户 app/server 未重启。
- 新观察：通过 API 创建的空会话已配置 nativeaudit/audit-model，但页面初始选中 GPT-6 Astra；原生模型已在列表中。手动选择后执行正确。这是会话模型初始化/异步目录加载的待复核问题，不能报告初始选择已正确。
- 原生 V2 的旧 /config、/path、文件等读取仍可能受旧初始化影响，#13 尚未全链路完成。模型能力中旧版独有的 temperature/interleaved 标志在 V2 没有对应信息，当前适配按 false；不宣称不存在信息损失。
- 一次“写夹具+git init+启动”的组合命令被自动审批拒绝（未提供具体原因）；随后分别写入夹具、初始化隔离目录和启动独立包均成功，不存在待批准动作。

### 第二十六批：空会话保留后端模型选择

- V2 Session 适配与服务器会话缓存保留 agent/model；无历史消息时使用 Session 自身的模型初始化。等待消息、模型目录和持久化状态就绪后再同步输入框，避免过早持久化默认模型覆盖后端选择；已有用户选择仍优先。
- 新增生产浏览器回归：模型目录延迟加载、空会话初始模型、手动切换和刷新后保留选择。旧构建在初始模型断言失败（session-model-before.txt）；新构建通过（session-model-after.txt）。夹具改用自定义服务商，避免官方免费入口进入连接引导；不涉及官方 API 接入。
- UI 588 单元测试、33 浏览器环境测试及 App UI/E2E 类型检查通过。生产导航 3 项通过，基线 performance-session-model-before.txt、变更后 performance-session-model-after.txt；该组合日志中模型切换测试首次因夹具走免费入口失败，修正夹具后单独回归通过，不将组合日志声称为全绿。
- 桌面构建 desktop-build-session-model 与 windows-package-session-model 成功。独立实例 PID 32156 / CDP 9240 / agent-browser desktop-audit-session-model 创建原生模型空会话，初始直接显示 Native audit model；未手动切换，发送后完成 AUDIT_OK，消息显示同一模型。见 packaged-session-model-ui.txt/png；原用户实例未重启。
- #13 原生 V2 旧读取接口兼容、最终故障恢复及安装交付验证仍未完成，整体目标保持进行中。另发现默认模型字符串在 local.tsx 与 prompt-model-selection.ts 按全部斜杠拆分，会截断嵌套模型 ID；尚未修改或验证，后续需要处理。

### 第二十七批：配置模型 ID 不再截断

- 修复 local 与 composer 两处默认模型解析：共用 parseModelKey，仅按第一个斜杠分隔服务商，保留后面的完整模型 ID；缺少服务商或模型时不产生候选项。
- 生产浏览器回归分别覆盖新旧布局，配置 nativeaudit/vendor/nested-model，目录默认模型故意设为另一个模型。旧生产构建两项均失败（nested-model-before.txt），修复后两项通过；同批空会话选择/手动覆盖回归及导航 3 项也通过，共 6 项（performance-nested-model-after.txt）。变更前导航基线 3 项通过（performance-nested-model-before.txt）。
- UI 588 单元测试、33 浏览器环境测试通过；App UI 与 E2E 类型检查通过，见 nested-model-validation.txt、nested-model-typecheck.txt、nested-model-e2e-typecheck.txt。本批尚未进入新的桌面包，最新运行的 CDP 9240 仍是第二十六批。
- 下一项仍为 #13 原生 V2 配置与旧读取/实例初始化的契约兼容；不得将模型列表与模型选择修复视为旧设置、文件、路径接口已全部正常。

### 第二十八批：原生配置下恢复文件读取与搜索，保留文本空白

- 确认四个旧文件 HTTP 入口的实现已调用 V2 FileSystem/Ripgrep，却仍在请求前强制初始化旧 Config。InstanceContext 对 GET /file、/file/content、/find、/find/file 只建立项目位置上下文；认证和工作区路由仍先执行，实际文件读取仍使用 LocationServiceMap。不把原生配置或有序权限降级成旧格式。
- 文件内容接口删除了 text.value.trim()，保留首尾空行、缩进、空格及 CRLF；此前界面读取内容与磁盘不一致。
- 新增完整 HTTP 回归先复现：原生配置目录列表 400、文本空白被删（native-file-before.txt，2 fail）。修复后文件/目录上下文/工作区路由 21 项通过（native-file-validation.txt），认证与配置 19 项通过（native-file-auth-config-validation.txt），专门追加的四个文件路径认证回归通过（native-file-route-auth.txt）。Zaovra 类型检查通过。
- desktop-build-native-file 与 windows-package-native-file 成功，含第二十七批。独立 PID 50496 / CDP 9241 / agent-browser desktop-audit-native-file 在 runtime-native-catalog-flow 原生配置目录调用四个接口全部 200，目录 2 项、文件内容 449 字符、文件搜索 1 项、文本搜索 2 项；见 packaged-native-file-http.json。原用户实例未重启。此次是打包运行接口验证，不宣称文件面板完整视觉验收。
- #13 仍有旧 /config、/path 等读取兼容未完成。另外源码中的 /find/symbol 和 /file/status 当前直接返回空数组，应继续检查实际 UI 调用与所需语义；此次未将它们加入跳过初始化列表或声称已修复。

### 第二十九批：路径发现不再依赖旧运行时配置

- /path 只返回 Global.Path 与已解析的项目位置，不依赖插件或模型执行器；将它纳入只建立项目位置的 GET 请求，避免原生 V2 配置触发旧初始化 400。
- 扩展真实 HTTP 原生配置回归：/path 返回正确 directory/worktree，并继续验证文件读取和搜索。改动前失败 400（native-path-before.txt）；修改后文件、认证和工作区路由 16 项通过（native-path-validation.txt），包含未认证路径请求 401，认证后 200。Zaovra 类型检查通过（native-path-typecheck.txt）。
- 本批尚未重新打包。#13 的旧 /config 读取与其余旧运行时功能仍未完成；需检查 VCS 审查路径，不把路径发现成功视为整个项目初始化已修复。
- /find/symbol 与 /file/status 的空实现目前未发现 app-ui 或 desktop-app 直接调用；桌面使用 /vcs/status、/vcs/diff。保留为接口完整性待查项，不宣称已确认它们导致桌面现有功能故障。

### 第三十批：原生配置下恢复 Git 审查读取

- GET /vcs、/vcs/status、/vcs/diff、/vcs/diff/raw 直接建立项目位置后调用现有 Git 服务，不再启动无关旧模型/插件配置；没有改变补丁应用或模型执行入口。
- 新增原生配置完整 HTTP 用例先复现 /vcs/status 返回 400（native-vcs-before.txt）。修复后验证新增文件的状态、增删行数、实际补丁文本和原始 diff；4 项文件相关测试通过（native-vcs-file-validation.txt）。Git 专项 12 项与认证 3 项通过（native-vcs-validation.txt）；该组合日志中的原始 diff 测试首次误按 JSON 解码，改为协议声明的文本后在上述文件回归通过，不称组合日志全绿。Zaovra 类型检查通过。
- 构建与独立打包 windows-package-native-vcs 成功，包含第二十九批路径修复。PID 16872 / CDP 9242 / agent-browser desktop-audit-native-vcs 在原生配置隔离目录实测 /path 与四个 Git 读取接口均 200，状态与两种 diff 均含实际 zaovra.json 改动。见 packaged-native-vcs-http.json；原用户实例未重启。
- #13 旧 /config 读取及其余配置相关功能仍待完成，Git apply 在原生配置下尚未验收。新增绕过旧启动的 Git 状态使用 InstanceState 缓存，后续需将这些目录的显式释放/全部释放纳入生命周期验证，不能仅凭读取成功认定资源释放正确。

### 第三十一批：释放未经过旧启动的目录状态

- InstanceState 创建缓存时登记目录；InstanceStore.disposeDirectory 对未进入旧启动缓存的目录也执行资源清理，disposeAll 同时处理注册表中的直接创建目录。避免只统计已 bootstrap 的实例而遗漏 Git 等状态。原有并发加载、重载、过期上下文释放保护保留。
- 新增实际 InstanceState 清理回调测试，分别调用 disposeDirectory/disposeAll 并断言 finalizer 执行一次。初版测试缺少 Project 服务依赖，placement-disposal-before.txt 是夹具失败，不能作为旧行为复现；修正服务层后测试通过。实例及启动、原生文件/审查/释放 20 项通过（placement-disposal-validation.txt）。
- 原生配置 POST /instance/dispose 的真实旧行为复现为 400（native-dispose-before.txt）。请求现在只解析位置，释放当前目录实例；不再先启动待释放的旧配置。HTTP 回归通过；未认证仍 401，认证后 200，连同配置回归共 11 项通过（placement-disposal-auth-config.txt）。Zaovra 类型检查通过。
- 本批尚未重新打包，最新运行 CDP 9242 仍为第三十批。#13 旧 /config 等兼容、原生 Git apply、重启恢复及安装交付仍未完成，目标保持进行中。

### 第三十二批：原生配置下应用 Git 补丁

- POST /vcs/apply 已有独立 Git 实现，不依赖模型配置或插件；直接解析项目位置后调用现有实现。认证、工作区路由和 Git 冲突校验不变。
- 完整 HTTP 用例先复现合法补丁被旧初始化拒绝 400（native-apply-before.txt）；修复后返回 applied=true，实际磁盘从 needle 改为 applied。重复提交返回 VcsApplyError/not-clean，文件保持不变。文件与审查组合 4 项通过（native-apply-validation.txt）。
- 新增认证回归：未认证返回 401 且磁盘未改，认证后实际应用成功；连同工作区路由 13 项通过（native-apply-auth-routing.txt）。Zaovra 类型检查通过（native-apply-typecheck.txt）。本批未变更公开 HttpApi/Protocol，无需重生成 SDK。
- 本批及第三十一批尚未进入新包。#13 旧配置读取仍需解决，重启恢复和最终安装交付未完成；不把服务端补丁应用回归等同于整个桌面商业使用验收。

### 第三十三批：打包运行验证补丁与释放后的继续读取

- desktop-build-native-operations 与 windows-package-native-operations 成功，包含第三十一、三十二批。独立 PID 39244 / CDP 9243 / agent-browser desktop-audit-native-operations；原用户实例未重启。
- 在原生配置隔离目录创建 operations-check.txt，打包后真实接口完成 Git 读取→应用补丁→读取 after 换行→释放实例→再次读取同一内容；全部 200，磁盘内容也确认为 after。见 packaged-native-operations.json。这是实例资源释放后继续使用的验证，不是进程崩溃或重启恢复验证。
- 同次运行 GET /config 仍返回 400，保留明确反证。旧全局 Config.getGlobal 的错误回退为空配置可能让设置页显示默认值；后续需解决配置读取契约，不能把更新成功或其他接口正常视为设置全链路完成。

### 第三十四批：排除全局格式错误被静默吞掉的假设

- 新增真实全局 HTTP 回归：配置 username=42，GET /global/config 返回 400；PATCH 改正后返回 200，后续 GET 正确显示 repaired。该用例在未修改生产实现时通过，证明第三十三批关于 Schema 错误回退为空对象的怀疑不成立；不得作为已确认缺陷报告。Effect 的 typed error 回退并未吞掉此 Schema 校验失败。
- 配置 HTTP 9 项通过（global-config-error-recovery.txt），Zaovra 类型检查通过（global-config-error-typecheck.txt）。保留回归用例，未改生产错误处理。
- 合法原生 V2 配置被旧格式拒绝仍是已确认的另一问题，未解决；总体目标保持进行中。本批无新增桌面构建。

### 第三十五批：V2 不再静默丢弃无效配置文件

- 检查读取契约时确认 Core V2 的 loadText 在 JSON 或 Schema 无效时返回 undefined，整个文件（包括同文件的权限限制）被忽略。旧测试明确期待忽略无效文件。改为带来源路径的 ConfigJsonError/ConfigInvalidError，使错误配置不能悄悄退回默认执行行为；不输出含凭据的原始配置文本。
- 更新行为回归在旧实现失败（config-invalid-drop-before.txt）；修复后无效 JSON 被拒绝，无效 username 与有效 deny 规则同文件时整体拒绝，修正 username 后原规则完整加载。配置文件测试 17 项及全部配置目录测试通过（config-invalid-drop-validation.txt、config-invalid-drop-suite.txt），Core 类型检查通过。
- 完整 HTTP 回归验证 V2 /api/provider 在错误配置下返回 400，PATCH 修正后无需重启即返回 200；配置 HTTP 9 项通过（config-invalid-drop-http.txt），Zaovra 类型检查通过。
- 与第三十四批不同，此处是 V2 加载器的明确丢弃行为；第三十四批排除的是旧全局读取吞掉 Schema 错误的假设。合法原生 V2 配置在旧 /config 读取中被拒绝仍未解决，本批尚未进入新桌面包。

### 第三十六批：项目与全局设置的原生配置兼容读取

- 新增只读 ConfigRead.preferences。旧配置读取成功时保持原返回；仅对旧 ConfigInvalidError 尝试从同一个 LocationServiceMap 的 V2 配置读取设置页可表示的字段。模型、Shell、更新设置等同型字段按 V2 优先级读取，provider_filter 映射为旧服务商允许/禁用列表。原生 providers/agents/有序权限仍由 V2 API/执行器持有，不伪造为旧执行配置，也不将兼容视图写回文件。
- GET /config 不再启动旧插件/模型运行时；/global/config 同样使用兼容视图。错误 JSON、无效值以及未知顶层设置仍报错；原生文档读取时重新校验原文件，避免错误被隐藏。现有公开响应 Schema 未改，因此无 SDK 重生成。
- 原生项目 GET /config 现返回 200，并显示 mixed/chat、audit-shell 和 legacy 禁用列表；JSON/JSONC 全局原生配置保存后 GET 显示 autoupdate=false，原文件及权限顺序保持。错误配置修正恢复和未知字段拒绝均通过；配置与认证共 14 项通过（config-preferences-final-validation.txt），类型检查通过。
- 初版单独提供 LocationServiceMap 导致刷新与读取使用不同缓存，回归发现后已移除，保持现有共享实例。全局释放现在同时使旧全局配置与 V2 目录缓存失效，避免显式重新加载继续使用旧配置；相关全局/刷新测试通过（config-preferences-refresh-validation.txt）。
- 本批尚未打包验证。兼容视图只覆盖旧设置契约能表示的部分，仍需验证原生配置服务商断开操作（现有自定义判断依赖旧 provider 字段）、其余旧运行时功能、进程重启恢复和交付门槛；不得标记 #13 全部完成或整体目标完成。

### 第三十七批：原生配置服务商停用写回

- 设置页对 catalog source=config 的服务商同样执行禁用配置分支，不再依赖旧 provider.npm 字段识别原生配置服务商。
- 项目/全局配置写回共用 patchPreferences：当原文件已含 native provider_filter 时，旧界面的 enabled_providers/disabled_providers 更新同步对应 allow/deny，避免原生字段优先级覆盖用户刚保存的选择；只同步用户明确更新的字段，不动另一侧过滤列表或权限规则。
- 完整项目 HTTP 回归验证 native deny 从 legacy 改为 mixed，执行器列表实际移除 mixed。全局 JSON/JSONC 回归验证 deny 同步、allow 保留、原生 providers/权限/MCP/skills/注释保留。配置 HTTP 10 项通过（native-provider-disable-validation.txt），服务端类型检查通过。
- UI 588 单元及 33 浏览器环境测试通过（native-provider-disable-ui-validation.txt），UI 类型检查通过。此次未新增实际点击断开的生产 UI 回归，不能将上述通用 UI 测试视为该交互已验收。第三十五至三十七批尚需新包验证；整体目标未完成。

### 第三十八批：真实点击发现新设置页与来源判定遗漏

- 已构建 windows-package-native-settings，独立 PID 42540 / CDP 9244，临时配置目录 zaovra-onboarding-64132f1c-414b-4e26-8168-0126dff142c5。原生全局 /global/config 读取 200，验证第三十六批设置读取已进入包。
- 真实点击断开后 UI 显示无连接，但后端 nativeaudit 仍存在、禁用配置未保存（packaged-native-settings-result.json）。发现默认设置页为 settings-v2/providers.tsx，上轮仅改旧页，现已补齐。
- 再构建 windows-package-native-settings-v2，独立 PID 48260 / CDP 9245，临时目录 zaovra-onboarding-471868eb-7422-4438-8264-6fae1a708faa。再次实际点击仍未停用（packaged-native-settings-v2-result.json）。进一步读取实际 Provider/Integration：nativeaudit 没有已连接凭据，Integration.connections=[]；目录适配却因 Integration 定义存在而判为 api 来源。
- 修复 provider-catalog：只有存在实际非环境连接才标记 api；可用配置服务商无连接时标记 config。新增真实 SDK/HTTP 回归，原生服务商同时存在空连接 Integration 时仍正确标记 config。UI 588 单元、33 浏览器环境测试及类型检查通过（native-provider-source-validation.txt、native-provider-source-typecheck.txt）。
- 最后这项来源判定修复尚未重建包，断开交互仍需再次实际验收。上述两个运行结果均为失败反证，不能标记断开流程完成。原用户实例未重启。

### 第三十九批：原生服务商断开实际验收通过

- 生成 windows-package-provider-source，独立 PID 53820 / CDP 9246 / agent-browser desktop-audit-provider-source。临时配置目录 zaovra-onboarding-26a67cc2-e15e-4608-be60-e984aadf0483，包含第三十八批来源修复。
- 从默认设置页实际点击 nativeaudit 的断开按钮后，GET /global/config 返回 disabled_providers=[nativeaudit]，GET /api/provider 的可用列表不再含 nativeaudit。见 packaged-provider-source-result.json 和 packaged-provider-source-ui.txt/png。
- 磁盘核对：原生定义保留在 zaovra.json，禁用项写入更高优先级的 zaovra.jsonc。初次只查 json 文件没有发现禁用项，随后检查两个文件确认实际保存位置；没有把界面隐藏等同于后端成功。
- 原用户实例未重启。本项全局原生配置服务商断开链路通过，不代表连接重建、项目覆盖全局过滤、其余旧运行时功能或进程重启恢复均已验收，整体目标继续。

### 第四十批：设置视图保留跨文件过滤继承

- 兼容视图此前整体取最后一个 provider_filter，后一个文件只定义 deny 时会丢失前一个文件的 allow；执行器按字段独立查找，两端结果不一致。
- 改为 allow/deny 分别选取最后一个明确设置，空数组仍能清除此前限制。真实 HTTP 回归使用 zaovra.json 定义允许 one/two，zaovra.jsonc 仅禁用 two，验证响应同时保留两者。
- 改动前 10 pass/1 fail（filter-inheritance-before.txt），修复后配置 HTTP 11 项通过（filter-inheritance-validation.txt），类型检查通过。本批尚未进入新包；整体目标未完成。

### 第四十一批：辅助接口复核与旧事件流恢复

- 在已运行的第三十九批独立包 CDP 9246 实测：原生配置 /config 为 200，/lsp、/formatter、/event 均 400，见 packaged-native-auxiliary-status.json。确认设置兼容读取没有自动修复这些旧运行时入口。
- /event 使用 EventV2Bridge 与位置上下文，不依赖旧配置；将其纳入不启动旧模型/插件的读取入口。认证回归使用原生配置，改动前 3 pass/1 fail（native-event-before.txt），改动后认证与事件 7 项通过（native-event-validation.txt），类型检查通过。
- 桌面主事件连接使用 /global/event，本项恢复旧 /event 契约，不将它误报为主事件连接失效。LSP.status 的实例状态直接调用旧 Config.get，格式化也需检查实际配置依赖，尚未修复。本批与第四十批未进入新包，整体目标继续。

### 第四十二批：格式化失败不再返回成功

- 检查语言服务和格式化初始化时发现独立错误：Format.file 对启动失败和非零退出码只记日志，最后无条件返回 true。
- 现在按顺序执行匹配的格式化器，并在全部成功时才返回 true；未匹配仍返回 false。失败日志不再展开配置环境变量，非零退出时记录退出码。
- 用真实 Node 非零退出进程和不存在的可执行文件复现，两条新增用例修改前失败（formatter-failure-before.txt）。修复后 13 项测试通过，包含实际文件顺序改写成功路径（formatter-failure-validation.txt）；包内 bun typecheck 通过。
- 原生配置的 /lsp、/formatter 400 尚未修复：两项服务的 InstanceState 初始化都直接依赖旧 Config.get，需继续处理配置兼容及共享 Location 生命周期。不能用设置兼容视图冒充完整运行时配置，也不能将此批返回值修复记为原生配置链路已通过。新改动尚未进入安装包，整体目标继续。

### 第四十三批：原生配置下语言服务与格式化恢复

- 新增 ConfigTooling.read，仅提供 lsp/formatter 两类选项：旧配置有效时沿用原加载行为；旧模式拒绝原生字段时使用 Core Config 的文件发现和解析，并重新严格验证源文件。跨文件对象覆盖合并，false 保持禁用含义。
- 此快照由语言服务/格式化的 InstanceState 生命周期管理，只构建 Config，不创建第二套 Session/LocationServiceMap；原生权限和服务商不会注入旧运行时。
- /lsp、/formatter 不再在分派前启动旧运行时。不是返回占位空结果：真实 LSP 协议子进程完成连接，真实格式化进程把 before 改为 before+formatted；HTTP 配置 PATCH 后重新读取返回禁用状态。未知字段和错误 formatter 类型仍返回 400。
- native-tooling-validation.txt：7 项通过；native-tooling-regression.txt：59 项通过；native-tooling-typecheck.txt：类型检查通过。扩展回归首次暴露 JSON 配置用例受其他用例创建的高优先级 JSONC 影响，已明确隔离并恢复该文件，重跑通过。
- 正在构建桌面产物（desktop-build-native-tooling.txt）；尚未声称新安装包或实际桌面 UI 已验收。本批不代表其他旧运行时配置使用方、恢复链路和最终交付门槛全部解决，整体目标继续。
- 桌面构建和 electron-builder --win --dir 均已成功，生成 windows-package-native-tooling（package-native-tooling.txt）；尚未启动该新产物，下一步需隔离配置验证真实包内接口及界面。原用户运行实例未重启。

### 第四十四批：新桌面包验收与 V2 自动格式化缺口

- 启动独立 windows-package-native-tooling，PID 54972 / CDP 9247 / agent-browser desktop-native-tooling；隔离临时目录 zaovra-onboarding-91621d2b-2433-4823-9b38-745e27515775。原用户实例未重启。
- 新包配置原生 providers/model、lsp=false、自定义 formatter：/global/config、/lsp、/formatter、/event 均 200，formatter 返回实际 audit 配置；PATCH 全局 formatter=false 后，/formatter 无需重启返回空列表。证据 packaged-native-tooling-result.json、packaged-native-tooling-refresh.json。
- 默认通用设置页可以正常打开，记录 packaged-native-tooling-ui.txt/png。此项只验收设置加载和包内辅助接口，不声称包内模型驱动 LSP/格式化已运行。
- 继续追踪真实模型工具发现待修缺口：Core 的 tool/edit.ts、tool/write.ts 和 file-mutation.ts 仍明确延后 formatter/LSP 集成，当前 V2 文件写入不会调用已配置的自动格式化。前一批真实服务测试证明旧 Format/LSP 服务可工作，但不能代表 V2 写文件链路已接通。
- 下一步需在 Core 内实现/迁移 Location 范围格式化能力并接入实际编辑/写入，保证最终磁盘内容、返回 diff、失败语义与文件锁一致；不能通过 Core 反向依赖 Server/旧 zaovra 包，也不能仅增加另一条未调用的接口。LSP 编辑通知/诊断集成同样尚待完成。恢复、最终安装交付等既有未完成项保持开放，整体目标继续。

### 第四十五批：内置格式化规则迁入 Core

- 将原 format/formatter.ts 的 26 个格式化器定义迁入 Core formatter/builtins.ts，通过 create(runtime) 接受文件发现、读取和进程探测依赖。Core 不引用旧 zaovra/Server 包。
- 旧 format/formatter.ts 改为注入原有 Filesystem/Process 并导出同一套定义；各语言命令、文件扩展名、配置检测和 ruff/uv 选择规则保持原实现，避免另造一套只覆盖自定义命令的 V2 实现。
- formatter-builtins-validation.txt：14 项通过，覆盖旧格式化成功/失败、顺序写入，以及原生配置真实 LSP/格式化服务测试。formatter-builtins-core-typecheck.txt 和 formatter-builtins-server-typecheck.txt 均通过。
- 本批是实际 V2 集成所需的共享规则迁移，不代表模型写文件会自动格式化。下一步构建 Core Location 范围格式化服务，接入文件写入锁内执行并处理最终 diff/失败反馈，再验证真实 V2 工具与桌面模型调用。现有独立测试包 CDP 9247 未包含本批迁移；整体目标继续。

### 第四十六批：Core 格式化执行服务

- 新增 formatter.ts 的 Location 范围服务，读取 Core 配置并复用上一批迁入的内置规则。支持跨文件格式化器字段和环境变量合并、false 禁用、自定义覆盖及 ruff/uv 联动禁用。
- 命令按匹配顺序执行，替换全部 $FILE 参数，使用 Location 工作目录和配置环境；探测及运行均有进程超时。结果分别返回 ran/failed 名称，不把非零退出或无法启动误报为成功，也不泄露环境变量内容。
- core-formatter-validation.txt：真实进程回归通过，验证顺序追加 AB、环境变量、非零退出、不存在命令和不匹配扩展名。core-formatter-typecheck.txt：Core 类型检查通过。
- 服务尚未注册进 V2 实际文件写入路径，本批仍不是端到端修复。下一步在文件锁内接入，向模型报告格式化失败，并基于最终内容构建编辑 diff；需覆盖 write/edit/apply_patch 等实际入口及原有并发/权限行为。整体目标继续。

### 第四十七批：V2 写入、编辑、补丁接入格式化

- FileMutation 的文本写入可显式请求格式化；写入、格式化和最终内容读取在同一目标锁内完成。普通未请求格式化的底层写入行为不变，避免影响备份/恢复等原始字节操作。
- write、edit、apply_patch 的新增/更新路径已实际启用格式化，依赖沿 Core 方向组合；编辑和补丁的 diff/行数基于锁内读取的最终内容。编辑的模型文本预览在执行格式化后也使用实际 diff。
- 工具结构化结果带可选 formatting.ran/failed；失败时保留已执行写入并向模型明确报告格式化失败和重新读取提示。write 不把内部整份最终内容混入工具结构化输出。
- formatter-integration-regression.txt：42 项通过，新增真实工具调用覆盖 write、edit、patch add/update，真实进程改写内容及失败回报；原有权限/陈旧内容/文件操作回归通过。已删除两条要求保留“格式化尚未实现 TODO”的过时断言。
- formatter-integration-http.txt：17 项配置/文件 HTTP 回归通过；formatter-integration-typecheck.txt 和 formatter-integration-server-typecheck.txt 类型检查通过。未改公共 Protocol/HttpApi schema；改动为内部工具输出。
- 尚需更强的格式化期间并发验证、内置格式化器真实项目验证、Session 模型调用及新版桌面包验证。LSP 诊断集成和其余商业交付未完成项仍开放，整体目标继续。

### 第四十八批：格式化并发与项目依赖验证

- 新增真实格式化子进程的文件锁回归：子进程通过启动/释放文件握手，格式化期间提交第二次写入，验证第一次结果捕获 formatted、后续写入最后保留 second。未用假的格式化返回值替代真实进程。
- 内置 prettier/oxfmt/biome 原先总通过 Npm.which 选择应用缓存版本；改为先在当前项目范围内寻找 node_modules/.bin 可执行文件，未找到才沿用缓存获取路径。这些规则同时被旧服务和 V2 服务复用。
- 在临时项目关联实际安装的 Prettier，提供项目 package.json 和 .prettierrc，验证真实 JavaScript 格式化遵守 singleQuote/semi 配置。formatter-project-validation.txt 通过；formatter-concurrency-validation.txt 保存单独并发测试结果。
- formatter-project-legacy-validation.txt：旧格式化与原生配置服务 14 项通过；formatter-project-core-typecheck.txt 和 formatter-project-server-typecheck.txt 类型检查通过。
- 尚需完整 Session 模型调用和新桌面包验证，包含工具结果/界面 diff、配置刷新以及格式化失败提示；LSP 诊断集成和其他既有交付门槛仍未完成。整体目标继续。

### 第四十九批：桌面包完整模型写入验收与卡片显示遗漏

- 构建 windows-package-v2-formatting（desktop-build-v2-formatting.txt、package-v2-formatting.txt），独立 PID 53696 / CDP 9248 / agent-browser desktop-v2-formatting。原用户实例未重启。
- 独立本地模型 fixture runtime-formatting-provider.ts，端口 60585，运行句柄 27195；项目 runtime-formatting-flow 使用真实安装的 Prettier 和项目 .prettierrc。第一次准备命令句柄 19773 最终 exit=-1 且文件未生成，核实终止后改用补丁创建并启动，没有重复启动同一活进程。
- 包内 Session ses_f79a71d51ffe7hfm7ebrl0yO7e 经实际 /api/session + /prompt 调用，模型触发 write，磁盘 audit-result.js 为 `const answer = { text: 'hello' }` 加换行；持久化工具结果 formatting.ran=[prettier]、failed=[]。下一轮模型请求收到真实 write 工具结果，最终 AUDIT_FORMAT_OK。证据 packaged-v2-formatting-admission.json、packaged-v2-formatting-context.json、runtime-formatting-flow/provider-continuation.json。
- 已在真实桌面导航至该会话，显示最终回复。展开“写入”卡片后没有文件名或内容详情，见 packaged-v2-formatting-ui.txt/png；后端格式化成功不能覆盖这项界面缺口。
- 初步定位 adaptTool 直接透传 V2 input/structured，只为 task 做别名映射，下一步应核对文件工具卡片契约并补齐映射/显示，同时遵守 app-ui 会话界面的性能基线要求。尚未开始该 UI 修复；LSP 诊断与既有商业交付门槛继续开放。

### 第五十批：文件工具卡片契约修复

- 实际检查 session-ui/message-part.tsx：read/write/edit 消费 input.filePath，edit 消费 metadata.filediff；apply_patch 的解析器只接受 filePath/type。V2 直接透传的 path、files[].file/status 因此丢失标题、详情或补丁内容。
- timeline adapter 为文件工具补齐别名，编辑映射首个实际 FileDiff，补丁映射 added/modified/deleted 为 add/update/delete。保留原结构化数据和实际 patch。
- write 工具在格式化执行后将锁内最终内容持久化为可选 structured.content；卡片使用该内容覆盖模型原始输入作预览，避免新记录显示格式化前文本。模型文本输出保持简短，不把整份文件追加给下一轮模型。
- 两条回归覆盖写入最终内容、读/编辑路径，以及补丁三类状态。tool-card-ui-validation.txt、tool-card-browser-validation.txt、tool-card-write-validation.txt 通过；UI/Core 类型检查通过。
- 修改前后均打包压缩编译适配器进行 1001 消息/100 次采样基准：median 0.119→0.195 ms，p95 0.492→0.638 ms，额外字段映射增加少量耗时。此为生产编译的适配器微基准，不是完整渲染帧率证明（tool-card-benchmark-before/after.json）。
- 尚未构建含本批的新包，需真实展开 write/edit/patch 卡片验收。历史上未保存最终内容的格式化记录无法仅靠新字段恢复当时文件内容；失败提示在卡片中的可见性也需继续核实。整体目标未完成。

### 第五十一批：写入卡片真实验收与失败提示遗漏

- 构建 windows-package-tool-cards，独立 PID 56732 / CDP 9249 / agent-browser desktop-tool-cards；模型 fixture 端口 60585 已核对仍由 PID 57228 监听，沿用同一活进程。原用户实例未重启。
- 经包内实际 Session 再次写入并格式化，卡片标题正确显示 audit-result.js；真实点击展开出现文件区域，预览文本 `const answer = { text: 'hello' }` 与磁盘一致。证据 packaged-tool-cards-admission/result.json、packaged-tool-cards-ui.txt/png。
- 将独立 fixture 的 prettier 命令通过 /config 改为 node -e process.exit(1)，同 Session 再次提示写入。后端 formatting.failed=[prettier]、结果文本明确 Automatic formatting failed，最终未格式化内容也正确持久化，但展开卡片没有显示失败警告。证据 packaged-tool-cards-failure-result.json、packaged-tool-cards-failure-ui.txt/png。
- 当前 fixture 配置保留故意失败命令，供下一轮复现；不能误把此配置当作成功格式化基线。下一步修复 UI 部分失败提示，再验证 write/edit/patch 的实际展示；编辑/补丁卡片尚未在此包完成点击验收。
- 写入卡片的成功显示链路通过，不代表整体验收通过；LSP 诊断、恢复和其他交付门槛继续开放。

### 第五十二批：格式化部分失败对用户可见

- 工具卡片外显示格式化失败提示，折叠时也可见；限定 completed 的 write/edit/apply_patch，保留原成功写入与内容预览。补丁失败按 applied[].resource 标明文件；未知/历史/成功元数据不产生警告。
- 增加 formattingFailures 的直接与补丁聚合回归，补齐 18 种 UI 文案。75 项 session-ui 测试、590 项应用单元测试及 session-ui/app-ui 类型检查通过（formatting-warning-*.txt）。
- 构建 windows-package-formatting-warning，独立 PID 55472 / CDP 9250 / agent-browser desktop-formatting-warning；沿用故意失败的 formatter fixture。实际 Session 两次写入均保留文件，并在卡片折叠/展开时显示“文件修改已保存，但自动格式化失败：prettier。”，见 packaged-formatting-warning-admission.json、packaged-formatting-warning-ui.txt/png。
- 独立生产包、两个工具卡片、60 帧采样：RAF 间隔 median 16.70→16.70 ms，p95 17.30→16.90 ms（formatting-warning-render-before/after.json）。这是小型稳定页面检查，不作为大历史或滚动性能的广泛证明。
- write 警告实际验收通过。edit/apply_patch 的警告聚合有代码测试，仍需实际模型与卡片展示验证；LSP 诊断、恢复、最终交付等未完成项不变。原用户实例未重启，整体目标继续。

### 第五十三批：编辑与补丁卡片实际验收

- 沿用当前独立桌面包 PID 55472 / CDP 9250，未重启。新增独立本地模型 runtime-edit-patch-provider.ts，端口 64135，运行句柄 3143；配置故意失败格式化器，对两个 .audit 文件分别执行 edit 和 apply_patch。
- 完整 Session 调用完成，existing.audit 从 before 变为 after，新增 added.audit 内容 patch content；模型收到工具结果后返回 EDIT_PATCH_AUDIT_OK。保存 packaged-edit-patch-admission/context.json 和 edit-patch-continuation.json。
- 真实点击展开两张卡片：编辑标题 existing.audit +1 -1，展示 before/after；补丁标题 added.audit +1 -0，展示 patch content。卡片内容与磁盘一致，分别显示失败提示 failing 与 added.audit: failing。见 packaged-edit-patch-ui.txt/png。
- 至此文件工具卡片的 write/edit/patch 字段映射与格式化部分失败显示均有实际包内证据。本批不是整体目标完成证明；LSP 写入通知/诊断集成、恢复、最终交付等既有未完成项保持开放。

### 第五十四批：语言服务客户端迁入 Core

- 将现有 LSP 客户端、语言扩展名映射和超时辅助迁入 Core。保留推送/拉取诊断、版本等待、动态注册与请求处理；不重写另一套协议客户端。
- Core 客户端通过 runtime 接受路径规范化、文本读取和进程停止，移除旧 InstanceContext/Server/Filesystem/Process 依赖；旧客户端入口注入原行为，既有调用方继续使用。移除旧客户端未使用的 instance 局部变量及两个流 any 转换。
- Core 增加与旧包一致的 vscode-jsonrpc 8.2.1、vscode-languageserver-types 3.17.5，锁文件仅新增对应工作区依赖声明。bun add 已正常结束（lsp-client-dependencies.txt），未重复启动安装。
- lsp-client-migration-validation.txt：35 项通过，包含真实 fake-LSP 子进程交互及原生配置语言服务/格式化流程。lsp-client-core-typecheck.txt 和 lsp-client-server-typecheck.txt 通过。
- 本批是复用协议实现的迁移，尚未实现 Core LSP 生命周期/内置服务发现，也未接入 V2 文件修改通知或将诊断返回模型/卡片，不能标记 LSP 链路完成。当前运行桌面包未包含本批迁移，整体目标继续。

### 第五十五批：Core 语言服务进程作用域与启动失败收敛

- 新增 LSPProcess.open，使用跨平台进程启动和作用域释放：关闭客户端连接，Windows 释放时终止子进程树；初始化失败同样有进程所有者负责清理。Core 不反向依赖旧运行时。
- 真实进程回归首次发现 Windows 不存在命令的 cross-spawn 事件序列为 spawn→error→close，没有 exit。仅监听 exit 仍会让 JSON-RPC 初始化等待超时；补齐 error/close 连接释放后，错误请求立即结束。
- lsp-process-validation.txt：正常客户端作用域释放及不存在命令 2 项通过，失败路径约 38 ms；lsp-process-typecheck.txt 通过。lsp-process-legacy-validation.txt 为修改后客户端/既有服务回归结果。
- 这一步实现进程生命周期基础，不代表 Core LSP 服务发现/缓存或 V2 写入诊断链路完成。下一步仍需组合服务、复用内置服务定义、接入实际修改及模型/UI诊断。当前桌面包未包含本批，整体目标继续。

### 第五十六批：Core 自定义语言服务与故障恢复

- 新增 Location 作用域 Core LSP 服务，读取配置并按服务复用有作用域的真实进程。文件变化发送版本通知并等待该版本诊断，返回当前诊断与失败服务名；项目外路径不启动服务。
- 同一服务的通知、诊断等待与失败释放串行执行，避免失败清理关闭另一个正在使用的共享连接。启动/通信失败失效缓存，下次变化可重新启动，不把一次启动失败永久缓存。
- 真实 JSON-RPC 子进程回归涵盖并发调用只初始化一次、错误文本改正后清除诊断、缺失脚本补齐后恢复、作用域释放及不存在命令快速失败。lsp-service-validation.txt：4 项通过、15 个断言；lsp-service-typecheck.txt 通过。
- 本批仅组合显式配置的自定义服务，尚未接入 V2 文件修改工具，也未迁入内置语言服务发现、复用桌面状态接口或完成模型/UI 诊断展示。当前桌面运行包未包含本批，不能视为诊断链路完成；整体目标继续。

### 第五十七批：38 个内置语言服务共用定义

- 将旧 LSP server.ts 的 38 个语言服务定义迁至 Core LSPBuiltins.create。显式注入文件、进程、解压和启动适配器，Context 仅需 directory/worktree，Flags 仅保留两项 LSP 开关，Core 不依赖旧 InstanceContext 或旧运行时。
- 旧 server.ts 保留每个具名导出，通过同一工厂注入原有依赖。保留语言扩展名、根目录发现、项目依赖解析和下载/启动规则，避免新旧两套规则漂移。
- Core 严格类型检查暴露 clangd/Kotlin/Lua 三处对未知 release JSON 的直接访问；使用 Schema 检查需要的 release 字段和资产列表，移除迁入代码的 any。
- lsp-builtins-migration-validation.txt：66 项既有 LSP/配置回归通过；lsp-builtins-core-typecheck.txt、lsp-builtins-legacy-typecheck.txt 通过。
- 该迁移尚未将 Core 的运行适配器及内置连接管理接通；V2 文件工具、模型诊断、桌面状态/UI 的统一仍需后续完成。当前运行包未更新，整体商业验收未完成。

### 第五十八批：Core 内置发现、根目录连接与运行适配器

- Core LSP 现在将 lsp=true 和配置对象中的内置服务纳入发现，保留禁用/覆盖语义及 Ty/Pyright 选择；按服务名与发现的项目根目录缓存连接，嵌套项目不共用错误的 root。
- 新增 LSPRuntime：FSUtil 文件适配、AppProcess 安装命令、真实管道进程、作用域终止。安装进程主动消费输出，防止大量日志塞满管道；关闭作用域后拒绝继续启动进程。LSPProcess 可接管内置工厂创建的进程并初始化既有客户端。
- Windows ZIP 解压通过环境变量传递完整路径并启用终止错误，避免单引号/通配字符破坏命令，损坏压缩包会失败。实际特殊路径压缩、解压与坏包检查通过；初次测试包装器误把 Bun matcher 的 void 返回传给 Effect.promise，改成 async 包装后通过，旧 archive-validation 日志保留这一过程。
- lsp-runtime-validation.txt：8 项、28 个断言通过；包括真实本地 biome 启动入口 fixture、两个嵌套根目录独立连接及复用、诊断清除/启动恢复、4 MB 安装输出、子进程释放与 ZIP 路径。该 fixture 验证发现/启动/协议连接，不能替代所有官方语言服务器的兼容性验证。lsp-runtime-typecheck.txt 通过。
- V2 文件修改工具尚未调用本服务，模型/UI 诊断与旧 LSP 状态接口统一继续开放；未构建新桌面包，整体验收未完成。

### 第五十九批：文件工具诊断返回模型

- write/edit/apply_patch 在实际文件修改和格式化完成后调用 Core LSP；将 lsp.diagnostics/failed 保存为可选结构化结果，并把文件位置、严重级别、诊断内容或服务失败提示返回模型。补丁分别保存新增/更新文件的结果。
- 诊断调用位于 FileMutation 提交之后，不延长写入锁。它读取文件当前状态；并发外部修改时可能反映更新后的内容，不能宣称与某次历史写入绝对绑定。配置缺失/禁用且无诊断时保持既有结果形状。
- 增加诊断报告 schema 与最多 20 条模型摘要，诊断等待设置 20 秒上限；这次尚未用真实挂起服务器验收该上限及后台初始化释放，后续需补证。移除已实现的 LSP TODO 及其旧文本断言。
- lsp-tool-validation.txt：38 项、150 个断言通过，覆盖实际 write/edit/patch 注册与调用、真实 JSON-RPC 进程返回、格式化后的新增诊断。lsp-tool-typecheck.txt 通过。补充 lsp-tool-partial-failure-validation.txt：8 项通过，缺失服务器与正常服务器共存时仍保存文件，同时返回诊断和失败提示。
- 初次 write 断言重复使用 Bun toMatchObject/asymmetric matcher 导致收到的 result 被 matcher 替换；改为对原始字符串分别 toContain 后通过，未为测试删除真实诊断。
- 桌面卡片尚未映射 lsp 字段，旧状态接口尚未统一，删除文件的缓存诊断清理也需核查。当前桌面包未包含本批，不代表完整端到端验收通过。

### 第六十批：真实挂起诊断超时与进程回收

- 新增真实不响应 initialize 的语言服务进程，记录 PID 后保持运行。首次测试证实约 20 秒诊断已返回超时，但 PID 仍存活，说明仅限制等待没有释放缓存作用域。
- 在持有对应连接锁的操作内增加 onInterrupt 失效缓存，覆盖超时/中断清理，不释放正在等待锁的其他调用所使用的连接。
- 修复后直接检查原 PID 不再存活，文件仍为原保存内容；随后将同一路径脚本修成真实 JSON-RPC 服务，再次 changed 成功初始化并返回空诊断，证明缓存不残留被中断状态。
- lsp-timeout-validation.txt：9 项、35 个断言通过；挂起、清理及随后恢复完整测试约 20.75 秒。lsp-timeout-typecheck.txt 通过。
- 本批证明实际挂起进程的等待和回收，尚不替代桌面卡片、旧状态接口统一、删除诊断清理和安装/恢复等未完成验收；整体目标保持进行中。

### 第六十一批：删除文件诊断清理与 Windows 迟到消息

- 客户端增加删除通知：清除已打开文档、推送/拉取诊断及版本记录，发送 didClose 和 watched-file deleted。对已删除文件的迟到推送/拉取结果忽略；重建并打开后重新接受诊断。
- Core removed 只访问已有连接，不为删除启动新服务；使用相同连接锁与超时/中断释放。apply_patch 删除成功后调用 removed，并保存空诊断或失败提示。
- 实际序列验证错误文件删除后、服务故意发送迟到错误、修改另一文件及重建同名文件。加强断言为整个诊断集合后发现 Windows URI 大小写变化可绕过删除记录，已按 Windows 不区分大小写的路径规则修复；新测试通过。
- lsp-delete-case-validation.txt：删除/迟到/重建链路通过；lsp-delete-tool-validation.txt：10 项补丁工具回归通过；lsp-delete-legacy-validation.txt：26 项既有客户端/生命周期回归通过；lsp-delete-typecheck.txt 通过。
- 此处清理运行中的诊断缓存，不改写历史工具结果。桌面卡片映射、状态接口统一及整包端到端验收仍未完成，整体目标继续。

### 第六十二批：写入与编辑卡片诊断字段映射

- 现有 write/edit 卡片读取 metadata.diagnostics，但 V2 保存为 lsp.diagnostics；新增适配并保留原结构化数据。相对输入路径通过明确的实际 target 映射诊断，不按文件名或路径后缀猜测。
- edit 在有诊断报告时保存可选绝对 target，write 已有此字段。适配测试覆盖另一项目同名文件，确保当前卡片得到正确诊断；未修改历史工具结果。
- lsp-card-validation.txt：8 项通过；lsp-card-core-validation.txt：12 项编辑工具测试通过；app-ui/Core 类型检查通过。首轮新测试缺少用户父消息导致适配器按既有规则丢弃助手消息，补齐真实会话结构后通过。
- 修改前后生产压缩编译的 1001 消息适配微基准：median 0.1853→0.2157 ms，p95 0.6350→0.5927 ms。该基准沿用无诊断内容的工具数据，只反映新增分支开销，不证明大量诊断或完整页面渲染性能。
- 尚未构建新桌面包验证实际展开显示；apply_patch 诊断展示、服务失败提示和状态接口统一仍待完成。整体商业验收未完成。

### 第六十三批：补丁卡片逐文件诊断显示

- 将 applied[].lsp.diagnostics 按该条目的明确 target 映射到 resource，仅提取该文件自己的报告，避免后续文件的整个诊断快照覆盖前一文件结果；删除文件保留空诊断。
- apply_patch 的单文件及多文件布局均在对应内容区域使用既有 DiagnosticsDisplay，沿用既有错误级别过滤和数量限制。
- lsp-patch-card-validation.txt：8 项适配测试通过，包含新增/更新/删除与不相关快照；lsp-patch-session-validation.txt：75 项通过；app-ui/session-ui 类型检查通过。
- 生产编译的既有 1001 消息微基准 median 0.1881→0.1925 ms，p95 0.6215→0.7754 ms。该输入仍为 write 卡片，不能证明补丁诊断布局性能；实际桌面渲染验收待完成。
- 尚未构建并点击验收本批桌面显示。语言服务失败的用户提示、旧状态接口统一与其他商业验收项继续开放，整体目标未完成。

### 第六十四批：诊断失败提示与新桌面包

- write/edit/apply_patch 完成后，在卡片外显示独立的语言诊断失败提示，折叠时可见；区分格式化失败，补丁按 resource 标明受影响文件。复用失败字段读取逻辑并覆盖畸形/历史/成功数据。
- 补齐 18 种语言文案，明确文件已保存但语言诊断未完成。lsp-warning-validation.txt：76 项、180 个断言通过；session-ui/app-ui 类型检查通过。
- desktop-build-lsp-diagnostics.txt 与 desktop-package-lsp-diagnostics.txt 均成功，生成 windows-package-lsp-diagnostics。原实例未重启。
- 独立测试启动 PID 59824 / CDP 9251，配置记录 lsp-diagnostics-launch.json。调试接口已返回 oc://renderer/index.html 页面且进程 Responding=True；agent-browser desktop-lsp-diagnostics 首次 snapshot 运行句柄 37092 仍在等待，不要因观察等待而重启。下一轮先继续该句柄及实际状态核查。
- 修改前旧生产包 RAF 采样 median 16.7/p95 16.8 ms，但卡片选择器计数为 0；该数据不足以支持卡片性能结论，尚未完成可比的新包采样。实际诊断显示和失败提示点击验收待继续，整体目标未完成。

### 第六十五批：真实桌面编辑/补丁诊断验收

- 原首次 snapshot 句柄 37092 仍等待，但同一 agent-browser 会话 eval 正常，页面已到登录入口。沿用 PID 59824 / CDP 9251，加载隔离账号 fixture，未重启进程。
- 沿用已监听的本地模型 64135，建立独立 runtime-lsp-flow 项目，配置格式化后追加 bad、正常诊断服务及故意缺失服务。包内创建 Session ses_lsp_desktop_1788964787560，真实 edit/apply_patch 完成；持久化结果含 Bad text、missing，模型继续返回 EDIT_PATCH_AUDIT_OK。证据 packaged-lsp-admission/context.json。
- 临时 anchor 未触发当前 MemoryRouter 导航；按已读源码写入该测试窗口 last-active-url 并刷新 renderer 后进入目标会话。没有重启应用或后端，且未将此测试导航步骤当作产品导航验收。
- 实际点击两个工具按钮展开：编辑 existing.audit 与补丁 added.audit 显示正确修改内容、错误 [1:1] Bad text，并显示文件已保存但诊断未完成的中文提示；补丁提示包含 added.audit。已查看 packaged-lsp-expanded-ui.png，文本证据 packaged-lsp-expanded-ui.txt。
- 新包两个诊断区域、两个失败提示，60 帧 RAF median 16.7/p95 16.8 ms（lsp-warning-render-after.json）。旧基线卡片数未确认，因此仅记录本次稳定页面表现，不作严格性能改善结论。
- 本次仅验收实际 edit 与单文件 add patch；write、多文件补丁、删除显示，以及旧 LSP 状态接口统一等未完成项继续开放。整体目标未完成。

### 第六十六批：写入、多文件补丁与删除的桌面验收

- 沿用 PID 59824 / CDP 9251。新增隔离模型 runtime-lsp-batch-provider.ts，端口 58237、运行句柄 88238；依次触发两次 write，以及包含两次 add 与一次 delete 的补丁，最终 LSP_BATCH_AUDIT_OK。
- Session ses_lsp_batch_1788965056241 的包内真实写入与补丁成功，磁盘保留 written/first/second.audit，doomed.audit 已删除。lsp.log 记录四次 open 后 close，持久化证据 packaged-lsp-batch-admission/context.json。
- 实际展开工具和文件折叠项：写入预览与磁盘一致并显示错误位置及 missing 提示；多文件补丁把错误显示在 first/second.audit 下，删除项显示删除差异且诊断区域数为 0。历史 doomed 写入卡片保留当时诊断。
- 已查看 packaged-lsp-write-ui.png 与 packaged-lsp-batch-expanded-ui.png；删除诊断计数见 packaged-lsp-deleted-card.json，文本见 packaged-lsp-batch-expanded-ui.txt。
- 至此新增诊断的 write/edit/单文件及多文件 patch/删除展示均有本地模型和真实桌面证据；不是所有语言服务器或商业整体完成证明。旧 LSP 状态接口统一、恢复、安装升级等其他验收项继续开放。

### 第六十七批：语言服务状态查询接入 Core

- 在当前真实包复现 /lsp 对已运行诊断服务返回 []，证据 packaged-lsp-status-before.json。根因为接口只查询旧 LSP。
- Core 增加连接状态快照，记录成功连接、初始化失败/中断及连接释放；失败后恢复回归验证 error→connected。将 LSP 明确暴露到共享 Location 服务，修复首轮接口查询因依赖不可见返回 500。
- /lsp 合并旧与 Core 状态，按 id/root 去重并优先当前 Core 结果；沿用既有响应形状，无公共 HttpApi schema 变更。
- Core 运行适配器进入旧包类型检查后暴露 Bun/Node ReadableStream 类型差异，改为使用标准 reader 流式写入并绑定取消信号，真实下载流→ZIP 提取回归通过。
- lsp-status-validation.txt 为状态失败/恢复测试；lsp-status-stream-validation.txt 3 项通过；lsp-status-http-validation.txt 6 项、49 断言通过；Core/旧包类型检查通过。并发校验时 Windows 进程测试超过默认 5 秒，明确给予进程/HTTP集成测试 15 秒后通过，未修改产品超时。
- 当前桌面包未包含本批；状态变更事件推送和新包实时刷新、真实执行后的 HTTP 非空状态仍待验收。整体目标继续。

### 第六十八批：语言服务状态变更事件

- Core LSP 状态变更通过共享 EventV2 发布既有 lsp.updated，并明确携带 Location 的 directory/workspaceID；失败、连接成功及 connection dispose 均覆盖。相同状态不重复发布。
- 真实进程测试验证缺失程序连续重试只产生一次 error 更新，修好后产生 connected 更新，随后终止该测试进程，收到断开通知且状态变为 error。
- lsp-status-events-validation.txt 通过；lsp-events-regression.txt：34 项、164 个断言通过，包含真实 20 秒超时、文件工具及删除/重建回归；Core/旧包类型检查通过。
- 首轮事件断言错误地把 recentAfter(undefined) 当作完整历史，查实现后改为真实发布的游标基准，保留真实事件通道。未通过模拟事件掩盖连接通知。
- 当前桌面包仍未包含第六十七/六十八批，需要新包验证实际诊断后 /lsp 的 connected/error 响应与事件驱动的界面刷新。整体目标继续。

### 第六十九批：新桌面包暴露状态共享仍未闭环

- 先构建并打包 windows-package-lsp-status，独立 PID 66228/CDP 9252，Session ses_lsp_status_1788966352742；真实文件诊断成功，但 /lsp 仍为空，证据 packaged-lsp-status-connected.json（文件名为预期状态，内容实际为空）。
- 发现 instanceHandlers 自行提供 locationServiceMapLayer，会绕过服务器共享实例；已去掉该 provide 及无用导入，使其继承服务器服务图。旧包类型检查通过；httpapi-file/httpapi-instance 11 项、66 个断言通过。证据 lsp-shared-instance-typecheck/regression.txt。
- 第二次构建并打包 windows-package-lsp-shared，独立 CDP 9253，启动信息 lsp-shared-launch.json；Session ses_lsp_shared_1788967241681，项目 runtime-lsp-shared-flow，沿用 58237 隔离模型。真实两次 write 和三文件 patch 完成，LSP_BATCH_AUDIT_OK；fixture lsp.pid=63120，lsp.log 有 initialize/open/close。
- 然而第二包 /lsp 仍为 []。通过设置→高级→服务器状态开启按钮，实际打开 LSP 页签也为空。证据 packaged-lsp-shared-connected.json、packaged-lsp-shared-empty-ui.json/png。未重启任何已有应用或后端，未终止诊断服务。
- 仅去掉 handler 自建 map 不足以闭环，不能将状态问题标记已修复。下一步追踪服务器 v2Runtime、AppNodeBuilder/LayerNode 编译、Location 服务中工具依赖与直接 LSP 暴露的实例身份。既有 location-layer 的 constructed/decoded 缓存测试通过（lsp-location-cache-validation.txt）；Effect 当前版本支持 plain object 结构相等，不能未经验证归因于引用相等。
- 新包测试配置路径可由 /path 查到；日志 F:/ 项目在 15:20:44 与 15:20:55 各 booting location services 一次，可能是旧 fileHandlers map 与 V2 map，也可能还有其他边界，需要真实调用链测试。PID/配置记录均保留。整体商业目标仍未完成。

### 第七十批：状态共享根因修复与真实桌面闭环

- 新增 httpapi-lsp-session.test.ts：真实 HTTP 创建 Session→本地模型调用 write→实际 JSON-RPC 诊断→模型继续→/lsp 查询。修复前稳定失败，返回 []，见 lsp-session-http-regression.txt。
- 临时实例/缓存键采样确认 handler 与执行使用同一 map，但 key 分别为 {directory, workspaceID:undefined} 与 {directory}，hash 不同，导致同目录二次创建 LSP。证据 lsp-map-hash-debug.txt；所有临时采样代码已移除。
- canonicalRef 显式统一 directory/workspaceID，消除省略可选字段与 undefined 的缓存差异；保留第六十九批去掉 handler 私有 map 的修复。增加 location-layer 的直接省略/undefined 比较。Core/旧包类型检查通过；Location 4 项12断言，HTTP 7项55断言通过（lsp-canonical-*-tests.txt）。
- 新包 windows-package-lsp-canonical 构建/打包成功，PID57800/CDP9254。会话 ses_lsp_canonical_1788968341881，项目 runtime-lsp-canonical-flow。旧隔离模型58237已退出，首轮显示 HTTP transport failed；新独立模型 PID23736/端口52477，经 /config PATCH 更新后同会话继续成功，未重启已有应用/后端。固定模型来源 runtime-lsp-canonical-provider.ts。
- 完成两次 write、多文件 patch，/lsp 返回 audit connected、missing error。通过设置开启状态按钮，LSP页签出现两服务且分别绿/红；证据 packaged-lsp-canonical-connected.json、packaged-lsp-canonical-ui-connected.json/png，截图已查看。
- 核验测试 pid 文件和完整命令归属后，仅终止 fixture node PID57260。页面未刷新（marker始终1788968356864），audit自动由绿色变红，随后接口返回error；证据 packaged-lsp-canonical-ui-disconnected.json/png、packaged-lsp-canonical-disconnected.json、lsp-canonical-fixture-stop.json。此项实际执行/查询/事件驱动UI闭环通过。
- 仍不代表所有语言服务或整体商业验收完成。恢复、安装升级等其余门槛继续开放；无需重做本项已通过验证。原实例未重启。

### 第七十一批：终端新旧接口共享实例与真实输入输出

- 在第七十批包复现：POST /api/pty 成功创建默认 PowerShell，GET /pty/:id 返回404；packaged-pty-default-before.json。另一次显式 command=node 的探测返回原生 File not found，未将其等同于默认终端失效；默认绝对路径 PowerShell可用，短命令解析边界待核对。
- 移除 fileHandlers、ptyHandlers、ptyConnectHandlers 私有 locationServiceMapLayer，统一继承服务器共享服务图。新增正式新旧PTY跨接口身份/更新/删除测试；Windows按现有原生PTY套件规则跳过此用例，不能当通过计数。
- 旧包类型检查通过；相关HTTP回归12pass、9skip、69断言（pty-shared-regression.txt）。LSP完整会话回归增加配置释放清理，独立 lsp-session-cleanup-validation.txt 通过。
- 新构建/打包 windows-package-pty-shared，PID56764/CDP9255，记录pty-shared-launch.json，agent-browser会话desktop-pty-shared。当前没有目标会话导航，仅隔离默认首页+API测试，API helper可处理204空响应。
- 实际新接口创建PowerShell→旧GET200→旧PUT改名→新GET看到改名→旧DELETE200→新GET404，全程同ID，证据packaged-pty-shared-after.json。
- 第二个真实终端通过旧connect-token及旧WebSocket接入，发送拼接输出标记命令（防止仅命令回显误判），收到PTY_ROUNDTRIP_OK，证据packaged-pty-shared-roundtrip.json。finally经新DELETE清理，未保留测试终端；此前旧包探测终端亦经新DELETE清理，空响应仅使测试helper首次解析报错，非删除失败。
- REPORT新增#20记录共享实例缺陷及修复。未重启现有应用/后端。下一步仍需跨进程持久恢复、最终安装升级验收；注意此前ZAOVRA_TEST_ONBOARDING=1强制ZAOVRA_DB=:memory:，不能用这些隔离桌面实例声称磁盘/重启恢复通过。

### 第七十二批：真实磁盘与跨进程恢复回归

- 新增 Core 正式 session-persistence.test.ts 和独立 fixture/session-persistence-process.ts。显式 Database.layerFromPath 指向 sessions.db，四个先后独立进程使用同一真实磁盘数据库；未使用此前桌面 onboarding 的内存库。
- 第一个进程创建/改名会话、queue admission、取消另一输入；第二个进程采用同Session ID，核对原入队记录、取消状态、精确重试、冲突拒绝和无进程内active所有权。
- 第三个进程显式 resume，真实本地HTTP模型返回结果；第四个进程读取完全相同历史，再次精确重试已提升输入不新增pending。模型请求计数严格为1，已取消文本不进入历史。
- 分别覆盖正常退出与 admission 提交后、数据库/Layer finalizer执行前由测试fixture自我SIGKILL的异常退出。只终止本次专用Core测试子进程，未重启任何桌面或后端进程。
- session-disk-crash-resume.txt：2项通过、40断言，约22秒；Core类型检查通过。早期 admit/reconcile 与正常resume中间证据另存 session-disk-persistence.txt、session-disk-resume.txt。
- 该回归证明已提交输入、取消/重试及完成历史的跨进程恢复，以及显式执行队列；没有证明 provider正在流式执行时崩溃的恢复，也不是桌面窗口重启/安装升级验收。下一步继续这些边界，整体目标未完成。

### 第七十三批：流式执行中异常退出与显式恢复

- 扩展跨进程正式回归为stream-crash：收到真实 session.next.text.delta 的 PARTIAL_RESPONSE 后，由专用Core fixture立即自我SIGKILL；保留已有持久投影截图JSON用于下一进程比较。模型HTTP保持连接，idleTimeout明确30秒，崩溃触发等待限5秒。
- 首轮方法等context出现文本时，HTTP fixture已因默认10秒空闲超时结束；该 session-stream-crash.txt 不能作为“执行中”证据。查源码确认Text.Delta为临时流，Text.Ended才写入完整文本，故改用真实事件通知作为崩溃触发，保留原失败方法说明，不改产品持久语义来迁就测试。
- 新进程verify-crash恢复相同已持久化context且active为空，模型调用数仍为1；下一新进程显式resume完成，最后新进程读取同一完成历史并精确重试不产生第三次模型调用。
- session-stream-crash-live.txt为修正后的单独用例通过；session-persistence-full.txt为正常退出、提交后崩溃、流式执行中崩溃三项全部通过，66断言；Core类型检查通过。没有重启原应用/后端，仅使用独立测试子进程。
- 本次证明已持久投影及显式provider继续，不声称临时文本增量必然完整保留，也不声称工具副作用执行中崩溃的去重或桌面窗口恢复已全部验收。
- 初步阅读安装升级发布路径：publish.yml Windows使用Azure登录和自定义签名脚本；script/sign-windows.ps1在CI签名参数缺失时仍exit0，electron-builder.config.ts设置verifyUpdateCodeSignature:false。尚未改动或验证这些发布边界，下一轮需审查实际交付策略和可执行验证，不能报告签名/安装升级通过。

### 第七十四批：发布签名失败语义与Beta更新渠道

- 实际运行PowerShell复现CI缺少/部分Azure签名配置仍exit0（signing-config-before.txt，两失败）。改为抛错；所有输入使用LiteralPath解析并要求文件存在，避免悄悄遗漏签名目标；Invoke-TrustedSigning后逐文件检查Authenticode Valid，否则失败。
- 新增desktop scripts/sign-windows.test.ts，缺少/部分配置、不存在目标、目录目标四项真实进程回归全部通过，10断言（signing-config-after.txt），在模块安装/网络签名前拒绝无效输入。真实Azure签名成功路径未验证。
- updater.ts按CHANNEL选择beta/latest，Beta允许预发布。原固定latest/false与打包Beta发布通道不一致。desktop typecheck通过，更新控制器/订阅/打包配置11项33断言通过（release-updater-regression.txt）。
- 使用ZAOVRA_CHANNEL=beta的真实桌面构建成功（desktop-build-beta-updater.txt），out/main/index.js中autoUpdater.channel="beta"；当前out是Beta构建，不要将其当作dev构建复用。没有打包/安装/发布或重启应用。
- Windows更新签名验证仍待修复：配置verifyUpdateCodeSignature:false，当前electron-updater的NsisUpdater.verifySignature在publisherName缺失时直接返回null。已通过异步问题向用户请求正式签名证书Subject/CN，尚未收到；不能拿Azure account/profile名称猜测签名发布者。此信息只阻碍该依赖分支，其他安装/恢复验证仍可继续。
- REPORT新增#21部分修复记录。整体目标继续，未达到blocked条件，也未宣称签名或安装升级整体通过。

### 第七十五批：安装中重复检查竞态

- 实际控制器回归复现：install进入installing并等待stop时调用check，会重新check/download且覆盖安装状态。新增阻塞stop的完整控制器测试，updater-install-race-before.txt先失败。
- check现在对ready/installing均返回当前状态，安装期间不再启动新检查。类型检查通过；控制器/订阅8项18断言通过（updater-install-race-after.txt）。本批未构建新包，当前out仍第七十四批Beta构建。
- 继续核对原生electron-updater/out/BaseUpdater.js：quitAndInstall调用install返回false时可以仅dispatchError并返回，不抛异常；成功时setImmediate调用app.quit。产品wrapper只catch异常，controller先stop再调用native并在返回后恢复ready，因而原生安装失败可能留下已停sidecar和quitting标记。此链路尚未修复/实机复现，不得把竞态修复报告为整个更新安装成功。
- 当前index.ts before-quit/will-quit均void stopSidecars，killSidecar先server=null后await current.stop；重复停止的调用不会等待同一个在途stop。后续改造需统一退出协调并避免失败安装先停后台，不能在测试中真的重启用户应用/后端。
- 正式证书Subject/CN异步问题仍未回答；不重复询问。还有独立可推进工作，未进入blocked状态。

### 第七十六批：安装失败不提前停止后台，统一退出等待

- createUpdaterController不再在安装尝试前调用stop；安装请求等待backend.quitAndInstall的Promise，接受后保持installing，失败才恢复ready。更新原有错误地期待native返回即ready的测试，并保留安装期间禁止新检查的回归。
- 新增updater-install.ts边界：监听实际更新库error事件与Electron原生before-quit-for-update事件，处理同步throw、异步error、30秒未启动，清理监听器；失败重置quitting，接受时保留，避免原生库只发error却被误判成功。没有导入别名。
- 新增createQuitHandler，before-quit先preventDefault，等待停止后再次app.quit；并发退出只清理一次，失败保留应用且可重试。index的will-quit不再重复停止；killSidecar返回共享在途停止Promise，避免server先置null后其他调用误判已停。
- 单元回归使用真实EventEmitter模拟原生事件契约，不是实际签名安装。19项44断言通过（update-quit-regression.txt），desktop类型检查通过；Beta构建成功（desktop-build-update-quit.txt）。当前out为包含本批的Beta构建，尚未打包、安装或更新已有测试实例。
- 下一步可通过全新独立Electron生命周期测试进程验证退出等待，不重启或关闭用户原实例；真实签名安装仍需要发布者证书信息/合适安装环境。Subject/CN异步问题尚未收到回答，其他工作可推进，整体目标未完成。

### 第七十七批：真实 Electron 退出事件与安装无响应边界

- 新增独立 electron-quit-probe.ts，直接导入产品 createQuitHandler，构建为 CJS 后使用仓库 Electron 可执行程序运行；两次均为全新、隐藏、独立 profile 的无窗口测试进程，由各自 app.quit 自然退出。未关闭、重启任何已有应用或后台。
- clean 模式在清理期间追加一次真实 app.quit，最终仅清理一次，262ms 后成功清理才进入 will-quit。retry 模式首次清理故意失败，未退出；再次请求后清理成功，538ms 后进入 will-quit，停止尝试共两次。两进程退出码均为0，断言结果 native-quit-validation.json，原始事件分别在 native-quit-clean-53ab513d/result.json 和 native-quit-retry-046f0398/result.json。
- updater-install.test.ts 补充同步 throw 与安装器始终不响应的正式测试；后者等待产品真实30秒时限，不替换全局时钟。连同异步 error、接受事件、控制器与退出协调，共13项34断言通过（native-quit-updater-regression.txt）；desktop 类型检查通过（native-quit-typecheck.txt）。本批只增加测试/证据，没有改变上一批产品实现，out仍第七十六批Beta构建。
- 核查发现 WSL listener.stop 目前调用 child.kill 并立即返回，stopAll 也是同步；本轮未验证 WSL Linux 子进程退出时序，不能把以上主进程事件测试扩展解释为 WSL 清理全通过。后续需检查此边界及完整桌面磁盘恢复/安装升级。正式证书Subject/CN仍待用户提供；整体目标保持进行中。

### 第七十八批：WSL 孤儿后台真实复现与停止方案验证

- 上轮属于进展：完成真实Electron生命周期证据和回归。本轮重新读取 desktop AGENTS、WSL sidecar/controller/index 当前实现，确认 stopAll 同步、listener.stop 仅 child.kill，且启动中的sidecar仅在稍后完成时按attempt失效清理。
- 本机只读列出 Ubuntu，运行独立 wsl-launcher-stop-probe.ts：Linux测试进程argv含UUID，Windows启动进程终止后仍在/proc匹配存活，结果 orphaned（wsl-launcher-stop-result.json）。同一探测仅对核验标记的测试PID发TERM，返回0；没有杀发行版、重启现有app/server或操作用户进程。
- 之后单独读取旧PID时已被另一检查bash复用，不能以PID存在等同旧进程存活，更不能再次按旧PID盲目kill。所有测试归属核验均用唯一argv标记。
- wsl-stdin-lifecycle-probe.ts 原型用 bash 复合脚本启动专用90秒sleep及stdin监控，以 wait -n 和 EXIT trap 关联生命周期。正常关闭stdin、强制终止专用Windows launcher两模式，后续/proc标记检查均exited，wsl-stdin-lifecycle-result.json。原型只验证机制，没有接入产品或声称真实业务服务清理已通过。
- REPORT新增#22。下一步应把经过验证的管道生命周期接入spawnWslSidecar，增加有界停止与Promise等待，并让controller/index等待已启动及在途启动清理；还需验证业务服务意外退出能及时上报、卡住进程的强制清理及并发停止。该项仍待修复，整体目标保持active，证书CN信息仅阻碍签名分支。

### 第七十九批：WSL 生命周期接入产品与真实 Ubuntu 回归

- 新增产品 wsl/lifecycle.ts：发送完整bash复合脚本后保持stdin，Linux侧将server与stdin监控关联；EOF或server退出触发清理，先TERM、最多六秒后KILL并wait。保留server自身失败退出码。createWslStop关闭stdin并共享等待Promise，十秒未退出明确拒绝，不把发送kill当成功。
- spawnWslSidecar改用此机制，启动失败也等待停止；stdin错误进入启动失败处理。controller/index等待停止，持有所有已生成sidecar并追踪在途启动，stopAll失效启动并等待其清理，失败保留所有权允许重试。旧后台停止失败时不再创建替代后台；停止完成后只删除仍指向同实例的映射。
- 新增正式 lifecycle.test.ts，显式ZAOVRA_WSL_TEST_DISTRO=Ubuntu运行，默认环境跳过真实WSL测试。直接调用产品脚本/stop函数，覆盖正常停止、Windows launcher崩溃、Linux忽略TERM后强制清理、Linux自行exit7。四项真实Ubuntu通过；连同当时12项controller测试共16pass/42断言，wsl-lifecycle-product-tests.txt。测试只对UUID标记的专用90秒sleep执行停止，没有重启现有app/server或终止发行版。
- 控制器新增在途启动等待/并发停止复用、失败清理重试、停止失败禁止替代启动回归。最终controller与quit-handler共17pass/41断言（wsl-shutdown-controller-tests.txt）；desktop类型检查通过（wsl-shutdown-typecheck.txt）。最终Beta构建成功（desktop-build-wsl-lifecycle.txt），当前out包含本批，未安装或重启已有实例。
- 当前证据覆盖产品底层进程生命周期和控制器，不等同真实WSL业务服务/工具子进程、桌面UI或安装升级全部验收。下一步应验证实际WSL服务运行/停止及其工具后代，继续完整桌面持久恢复和签名升级等原有门槛。整体目标未完成；未调用complete/blocked。

### 第八十批：WSL 脱离进程组的工具清理与实例隔离

- 重新核查 Core Bash 工具在Linux以detached:true启动，不能用上一批“主后台退出”推断其工具后代也退出。正式lifecycle.test.ts增加setsid工具fixture，当前产品停止后/proc仍匹配唯一argv标记；wsl-detached-tool-before.txt稳定失败，随后测试按标记清理自己的残留sleep。
- lifecycle脚本为每次后台生成UUID环境归属标记，只在后台子作用域export，工具后代继承。清理时匹配/proc环境中的完整键值，TERM/宽限/KILL覆盖仍携带该归属的脱离后代；不输出读取到的环境或凭据。控制shell与其他后台不继承本次新标记。
- 修复后原五场景通过，增加同时运行两个独立后台的隔离测试，停止第一实例后第二实例的唯一标记进程仍在。最终真实Ubuntu六项21断言全部通过（wsl-owned-process-tests.txt）；类型检查通过（wsl-owned-process-typecheck.txt）；Beta构建成功（desktop-build-wsl-owned-processes.txt），当前out包含本批。现有应用/后端未重启。
- 覆盖的是产品生命周期函数、独立Linux进程及继承环境的detached工具，不能宣称清除环境或切换到不可读取UID的任意进程都受此机制约束；也未验证实际WSL业务服务完整HTTP/模型/工具/UI链路。只读command -v显示Ubuntu有setsid，但PATH没有zaovra/bun，尚未据此安装或改用户环境。后续需要独立可执行业务fixture或构建产物继续验收。原整体商业门槛保持开放。

### 第八十一批：实际 WSL 服务验收产物准备，运行时下载进行中

- 上一轮有实际产品修复和真实Ubuntu证据，属于progress。本轮检查正式build.ts发现其默认全平台构建并删除dist，不为单次隔离验收调用此整套脚本。
- 新增quality目录 build-wsl-business-server.ts/wsl-business-server.ts/run-wsl-business.ts：直接导入当前Server，计划交叉编译Linux独立程序；入口包含本地测试模型和项目配置；驱动使用产品WSL生命周期在UUID隔离/tmp目录启动，HTTP创建会话→模型调用真实Bash写文件→读取完成历史与实际文件→停止。未改业务源码或SDK generated文件。脚本已格式化，但尚未执行成功，不能计入已通过测试。
- 首次编译确实终止失败：Bun1.3.14报告无法提取bun-linux-x64-v1.3.14，wsl-business-build.txt，无可执行产物。检查本地Bun CLI --help与bun-types确认compile.executablePath可使用预下载运行时；官方交叉编译文档 https://bun.sh/docs/bundler/executables 提供相关机制说明。
- 从官方GitHub固定版本下载bun-linux-x64.zip到本次quality目录，不安装或改Ubuntu PATH。第一次curl句柄71818在120秒上限后明确退出，获得10,008,064/35,969,274字节；确认终态后使用--continue-at续传，当前句柄22105已核验仍运行，日志wsl-runtime-download-resume.txt。不能把观察等待当终止或再次启动重复下载。
- 下一轮首先轮询同一22105句柄及文件长度；下载完成后验证ZIP、仅解压本次quality目录，构建脚本会使用bun-linux-x64/bun的executablePath，再运行隔离业务验收。尚未启动该业务服务，没有重启现有app/server。此为有效进展及有具体句柄的等待，不是整体阻塞，目标保持active。

### 第八十二批：重新启动的清理失败保护

- 本轮开始重新轮询下载句柄22105，仍运行且文件持续增长（约12.2MB→21.9MB）；后续继续同一句柄，不启动重复下载、不把观察超时当进程失败。Linux业务验收尚未运行。
- 等待期间核查index的另一个退出入口：relaunch仍在stopSidecars().finally无条件app.relaunch/app.exit，并发调用也不合并。这与前面修复的普通before-quit分支不同，REPORT新增#23。
- 新增createRelaunchHandler并接入index：共享在途清理，成功才调用重启，失败恢复quitting并允许重试。正式relaunch与quit-handler四项8断言通过（relaunch-cleanup-tests.txt）；desktop类型检查通过（relaunch-cleanup-typecheck.txt）；Beta构建成功（desktop-build-relaunch-cleanup.txt）。当前out包含本批；没有真实重启用户应用/后台，不把单元契约当实机重启验收。
- WSL业务驱动另外增加stop后健康端口不可达断言，并在清理可能失败之前写运行日志，防止假阳性和错误证据丢失；脚本尚未运行，不能计入通过。
- 下一轮继续获取22105下载终态/文件长度，再核验压缩包和构建/运行真实WSL业务fixture。整体目标仍进行中，未调用complete或blocked。

### 第八十三批：实际 WSL 服务、Bash任务与执行中停止闭环

- 上轮属于产品修复进展。本轮持续轮询同一下载22105并观察文件增长，最终该句柄退出0；ZIP完整大小35,969,274字节。检查目录仅bun-linux-x64/和bun-linux-x64/bun，按确切entry解压到本次quality目录；运行时SHA256记录wsl-bun-runtime-hash.json。未安装到Ubuntu或改用户PATH。
- 使用本地运行时executablePath后Linux交叉编译成功（wsl-business-build-manual-runtime.txt），直接编译当前Server源码与隔离本地模型fixture；随后增加执行中工具模式重编译成功（wsl-business-build-active-tool.txt）。当前quality/wsl-business-server为后者，产品desktop out仍第八十二批Beta包。
- 发现Server.listen的port:0优先4096，fixture改为先分配明确临时端口，并设置本次独立认证；避免误用已有端口。配置/DB/项目均在UUID的Linux /tmp目录，未操作已有用户项目、应用或后台。
- 完成模式实际通过：Linux Server→Windows HTTP创建会话/提交prompt→本地模型调用Core Bash→真实写入audit-result.txt→模型最终回复→HTTP历史/实际磁盘内容核对→停止→端口不可达。证据wsl-business-result.json，Session ses_wsl_112a5bd4f13644ad82578dde9d3066d6，内容WSL_BUSINESS_TOOL_OK，最终文本WSL_BUSINESS_COMPLETE，测试退出0。
- 执行中模式首轮Windows访问刚listen的WSL端口ConnectionRefused，fixture已finally清理并退出1（wsl-business-active-tool-test.txt）。这是驱动未等端口转发，不是产品缺陷；驱动接入产品已有pollWslHealth并在轮询后再次强制校验健康，不因超时直接算成功。
- 新独立执行中模式通过（wsl-business-active-tool-health-test.txt退出0）：实际模型调用Core Bash，命令记录自己的PID并exec带UUID argv的90秒sleep；停止前/proc确认该命令正运行、历史没有最终回复；停止后同PID唯一argv标记不再存在、服务端口不可达。证据wsl-business-active-tool-result.json，Session ses_wsl_e37502aed9c14206b08abfba66f60c5f，serverPID17/toolPID43。所有停止仅针对本次独立fixture。
- 本轮证明实际Linux业务服务与Core Bash执行中的生命周期，不等同WSL安装/版本解析、打包桌面UI操作、任意外部工具或完整桌面重启恢复验收。REPORT #22补充证据；原完整商业门槛仍开放，未调用complete/blocked。

### 第八十四批：真实 Electron 主进程存储的跨进程恢复

- 重新核查恢复分工：windows/registry持久化窗口ID，electron-store保存每窗口数据；renderer的MemoryRouter另用localStorage保存最后路由。没有以某一层替代全部窗口恢复。
- 新增electron-store-recovery-probe.ts，直接使用产品getStore/removeStoreFile/createWindowRegistry。独立Electron进程指定本次quality内profile，写入两窗口数据和含false/0的设置，经registry关闭一窗口并标记退出保留另一窗口；后一个独立进程读取真实磁盘，断言保留ID、窗口数据、设置值、被关闭窗口文件删除及实际store路径。
- 首个ESM探针使用顶层await app.whenReady，停在入口初始化且未写store；PID56304在15秒观察结束后仍存活，未当成终态。改为whenReady回调并增加10秒自退出/错误记录后，新独立探针正常运行，产品实现没有为迁就探针而改动。确认新方案成功后，核验旧PID的完整探针路径/profile归属再清理该废弃专用测试进程；记录native-store-stale-probe-cleanup.json，不涉及已有应用或后台。
- 正常写入/退出→新进程验证，两进程均exit0，native-store-fixed-write-b70ff1d0/verified.json为passed；写入后专用fixture自我SIGKILL→新进程验证，前者exit1、后者exit0，native-store-fixed-crash-024544d5/verified.json为passed。四次均为无业务服务器、独立隐藏Electron测试进程。
- 本轮证明产品主进程存储和registry的真实磁盘持久性，未验证完整BrowserWindow、MemoryRouter/localStorage、打开项目后会话UI恢复。产品代码/out未改变，仍第八十二批Beta构建。下一步继续渲染路由和完整桌面恢复等剩余门槛；整体目标保持active。

### 第八十五批：真实渲染进程的多窗口路由恢复

- 将desktop renderer内原有getLastActiveUrl/写入方法/DesktopMemoryRouter原样移入window-router.tsx，index改为导入。此为便于直接验证产品模块的边界整理，没有改路由保存语义、会话timeline或App UI页面。
- router-fixture通过Vite/Solid构建，直接import产品DesktopMemoryRouter，渲染真实路由位置和导航按钮；electron-router-recovery-probe创建两个隐藏BrowserWindow，使用与产品同类的secure/standard oc://renderer源、sandbox/contextIsolation及独立profile。
- 首个独立Electron进程分别点击两窗口导航按钮，断言各自路径含windowID、?panel=diff和#last后正常退出；第二独立进程使用相同profile，直接读取实际渲染DOM确认两者分别恢复，再令a返回首页并加载页面，断言a仍首页而b不变。未以手工设置localStorage代替产品导航写入，也未使用内存DOM。
- 两进程均退出0，native-router-0dcbb676/write-result.json与verify-result.json均passed。外层PowerShell最初因为尝试读取不存在的可选error文件留下exit1；随后独立检查两结果和error文件不存在通过，非产品或probe断言失败，未重复启动已完成探针。
- desktop类型检查通过（window-router-typecheck.txt）；Beta构建通过（desktop-build-window-router.txt）。当前out包含本批模块整理。没有重启现有应用/后台，只有专用无业务服务测试进程自然退出。
- 本轮证明真实Electron渲染环境中的产品MemoryRouter保存、跨进程恢复及双窗口隔离；与前批registry/store证据仍是不同层次的检查，尚未完成完整产品登录/项目/业务会话UI统一恢复验收。整体商业目标继续。

### 第八十六批：服务身份错配与启动重建修复

- 核查desktop App：实时WSL状态决定effectiveDefaultServer，外层keyed Show会随starting→ready→failed重建AppInterface。新增createStartupServer等待初始资源ready后只选择一次，避免后台晚就绪抢走用户已开始操作的应用；初始已ready的WSL失联时保留其身份。
- 核查ServerProvider.current原先find失败便取allServers()[0]，selected key仍是WSL但HTTP已变Windows。抽出实际选择逻辑并新增正式回归，修复前稳定失败返回本地sidecar（server-identity-before.txt），修复后只允许明确key匹配。
- ConnectionGate对缺失当前连接返回失败，并在业务子树显示条件中核对current，避免把undefined当健康或继续构造SDK。继续核查指定会话/草稿目标：ServerSDK/ServerSync的props.server?.() ?? server.current也会错选；现共用resolveServerTarget，显式目标缺失时不读取fallback。未改会话、timeline或事件投影。
- browser条件下Solid真实响应式启动选择测试4pass/12断言（startup-server-browser-tests.txt）；默认SSR条件下新增两响应式测试会skip，不能把SSR跳过算通过。身份局部初轮13pass/34断言，之后增加显式目标测试并全套App UI单测593pass/1609断言（server-selection-app-unit.txt）。App UI和Desktop类型检查通过。
- 最终Beta构建通过（desktop-build-server-selection.txt），当前out包含本批。没有重启现有app/server。REPORT新增#24。
- 这些证据证明选择/调用边界及编译，不是实际完整UI断线恢复验收。后续重点：指定路由目标消失时当前无SDK会进入错误处理，需验证恢复后是否能自动回到任务、保留草稿和窗口状态；同时验证晚就绪WSL不重建工作界面。原完整商业门槛继续开放。

### 第八十七批：工作区挂载稳定性与不可用服务标签丢失

- 扩展真实Electron渲染fixture，直接使用产品createStartupServer和相同keyed边界：分别以WSL晚就绪/初始已就绪启动，连接→断开→连接共六次状态转换，工作区挂载计数始终1、输入unsent work不变。native-startup-e59bfee8/startup-result.json passed，专用Electron退出0。这是产品启动选择模块的实际DOM验证，非完整AppInterface业务场景。
- 修改会话/草稿路由前按AGENTS记录当前生产基准：server-route-recovery-baseline.txt，三项通过，blank/unknown均0。使用独立临时端口和新测试服务，不重启现有app/server。
- TargetServerRoute/ResolvedDraftRoute在目标不可用时不构造SDK/同步子树，改为已有翻译的服务不可用状态与设计系统首页按钮。目标列表恢复后Show可重新创建该目标上下文。新增正式server-route-recovery.spec.ts浏览器用例验证缺失目标服务的会话/草稿入口。
- 首轮会话通过、草稿失败回首页（server-route-recovery-browser.txt）；沿真实页面追到TabsProvider实时按server.list过滤标签和最近关闭记录。此清理错误地把暂不可用当成删除。移除这种过滤，保留标签/草稿内存/信息与最近关闭记录；既有用户显式removeServer仍负责清理。REPORT新增#25。
- 修复后生产构建浏览器五项通过：三导航基准+两缺失服务入口（server-route-recovery-final-browser.txt）。server-route-recovery-comparison.json保留前后三项原始summary，均blank/unknown=0；单次小样本不宣称性能提升。App UI单元593pass/1609断言，App UI/Desktop类型检查通过。
- 最终Beta构建通过（desktop-build-route-recovery.txt），当前out包含本批。未重启用户或已有QA应用/后台，只有专用测试浏览器/服务正常结束。
- 尚需实际完整服务列表离线→恢复时的任务/草稿内容自动恢复，以及原有桌面持久恢复、安装签名等门槛。没有把静态缺失目标+返回首页用例冒充动态重连闭环；整体目标保持active。

### 第八十八批：动态断连时会话清理重入

- 新增独立 dynamic-recovery.vite.config.ts/playwright-dynamic.config.ts，保留实际 AppInterface 与生产构建，仅在测试入口通过事件切换传入的服务器列表；无生产测试钩子。正式 dynamic-server-recovery.spec.ts 默认跳过，显式 ZAOVRA_AUDIT_DYNAMIC_SERVERS 才运行。
- 首轮选择器错误已纠正，不算产品缺陷。之后稳定复现：草稿通过，会话离线后旧输入框残留；console/stack 日志确认存储服务列表为空且出现 Solid cleanNode 空引用异常。临时隔离构建诊断捕获清理重入调用来自 DirectoryDataProvider 的 serverSync().session.unpin；此诊断修改仅用于定位，最终配置已经移除，产品依赖未修改。
- 按 AGENTS 在生产修改前记录 dynamic-recovery-baseline.txt，三项导航基准通过。产品 directory-layout.tsx 改为捕获 pin 所属 session，清理直接操作原对象，避免销毁时读取失效的服务 accessor。
- 未修改 Solid 的最终动态构建首轮2项通过；正式测试进一步覆盖每场景连续两次离线/恢复，并断言路由、输入内容与 pageerror。dynamic-recovery-final.txt 2pass；普通生产构建导航与缺失服务入口 dynamic-recovery-after.txt 5pass。dynamic-recovery-comparison.json 保存三项前后 summary，blank/unknown 均0，不以小样本声称性能提升。
- App UI 单元593pass、1609断言；App UI/Desktop 类型检查通过。Beta desktop build exit0（desktop-build-dynamic-recovery.txt），当前 out 包含本批修复，renderer main-l9mLHElO.js。
- REPORT新增#26。本轮没有重启现有app/server，独立正式浏览器测试正常结束。服务列表转换使用本地 API fixture，是生产前端恢复证据，并非完整 Electron/WSL 真实网络和整机账户/项目/任务恢复验收。发布签名CN与原商业全链路剩余门槛仍开放，整体目标保持active。

### 第八十九批：服务凭据更新后旧 SDK 缓存继续使用

- 上一目标轮为实质进展：#26动态清理异常已修复、构建及恢复测试通过。本轮沿恢复后的调用继续审查 GlobalProvider，确认其缓存仅比较服务key，而编辑相同URL的服务密码会走server.add更新同一个key。
- 隔离生产入口新增测试专用密码变更事件，未在产品加入钩子。最初只等目标message请求因缓存未触发而超时，未作为产品失败依据；改为观察目标会话业务请求后，server-credentials-request-before.txt明确返回旧认证信息[undefined,undefined]，预期新fixture认证头，构成失败证据。
- 修改前用已确认当前的app-ui生产产物记录server-credentials-baseline.txt，三导航通过。global.tsx保存HTTP字段快照，对地址/用户名/密码变化重建上下文并清理旧对象，显示名变化不重建；ensure优先查当前服务列表以防旧对话框连接对象回滚缓存。未修改SDK generated文件。
- server-credentials-final.txt三项通过，精确观察目标sessionID请求使用新认证头，并无pageerror；另外会话和草稿各两次离线/恢复仍保留内容。测试只是AppInterface输入更新到实际请求的链路，尚未覆盖设置对话框操作与真实远程认证服务完整闭环。
- server-credentials-navigation.txt五项通过，server-credentials-comparison.json记录前后导航summary，blank/unknown均0；App UI单元593pass/1609断言，App UI/Desktop类型检查通过。Beta构建desktop-build-server-credentials.txt exit0，当前out包含本批。
- REPORT新增#27。未重启现有app或服务器，只运行独立正式测试。整体目标保持active；完整桌面持久恢复、真实远程编辑认证、安装签名等剩余门槛仍开放，官方API未接入不单独报错。

### 第九十批：设置菜单与堆叠弹窗的实际编辑链路

- 上一轮#27为实质进展。本轮新增server-credentials-settings.spec.ts，直接通过实际设置、服务菜单和编辑表单操作，未使用前批入口事件或手工改产品状态。
- 初轮角色定位Edit失败；隔离DOM诊断证明菜单portal祖先aria-hidden=true（server-settings-edit-diagnostic.txt / server-menu-ancestors.txt）。未误修ItemLabel或修改组件库依赖。修改前记录menu-label-baseline.txt三项生产导航通过。
- MenuV2常规菜单/子菜单/上下文菜单增加组件库识别的data-kb-top-layer，使父modal不隐藏独立portal。随后Edit角色定位通过，但点击username仍无法聚焦，输入落入URL。server-input-focus-dom.txt明确显示聚焦前后均为底层Servers标签，证明堆叠焦点争抢，不是Playwright选择器问题。
- DialogProvider将modal限定到栈顶id，使底层设置不再捕获子弹窗焦点。未修改会话内容、第三方库或生成SDK。UI/App/Desktop类型检查通过，App单元593pass/1609断言。
- server-settings-settled.txt完整保存流程通过：可访问菜单→编辑→用户名焦点/值→密码→保存→退出设置→未发送文字保留→目标会话新认证头，pageerror为空。退出会等待既有100ms关闭过程150ms；此前提前Escape被关闭锁忽略属测试时序，未单列为缺陷。
- 用例扩展再次打开编辑并Cancel后切换父General页；最初在目标会话响应到达但页面未完成时提前按快捷键，测试超时。改为等待真实目标标题显示后，server-settings-save-cancel-ready.txt 1pass（6.0s），同时确认用户名保存值回显、取消后父设置可用、无pageerror。
- server-settings-final.txt中三导航和两缺失目标入口均通过（该次新增设置用例尚有上述退出时序失败，不能声称6/6）；dialog-stack-comparison.json保留前后三导航summary，blank/unknown均0。最终设置用例单独通过的证据见上一条，不混淆中间失败。
- Beta构建desktop-build-dialog-stack.txt exit0，当前out包含本批，main-CfnNIS0m.js。生产修改完成后的测试扩展只影响e2e文件，未改变产物。REPORT新增#28。没有重启任何现有app/server。
- 此轮已把#27从入口状态更新验证推进到真实设置表单→业务请求的闭环，响应仍为本地API fixture。完整Electron账户/项目/业务持久恢复、真实远程认证、安装签名等商业门槛仍待，整体目标保持active，官方API未接入不报错。

### 第九十一批：服务凭据的保存、恢复与清除

- 上一轮为实质进展：#28堆叠modal与菜单可访问性已修复。本轮扩展同一正式设置流程，以新页面读取浏览器真实持久存储，避免reload触发原页种子脚本覆盖配置。
- 原页实际保存用户名/密码后，同浏览器上下文创建新页面，仅安装API响应fixture，不写入server/settings/tabs种子；实际会话请求带已保存认证头，编辑框密码正确回显。随后在该页实际清空密码并Save，再创建第三页读取持久存储，业务请求存在且所有捕获的目标会话请求均不带Authorization；无pageerror。
- 首轮未进入新增持久化部分，因为父设置关闭后立即切会话并按快捷键，仍可能处于原100ms关闭锁。前批只等待子弹窗退出不足以覆盖父层退出。本轮在父层退出后同样等待150ms，再继续后续操作；不是改产品或放宽凭据断言。
- server-credentials-persistence-settled.txt 1pass（6.6s），完整覆盖前批保存/取消与新增恢复/清除。产品代码未修改，当前out仍第90批main-CfnNIS0m.js，未重复构建未变的产物；未重启现有app/server。
- 检查了persisted与desktop storage实现：当前makePersisted未配置sync，desktop储存适配只有读写，尚需对已打开多窗口的配置实时一致性做实际验证。此处是待验证边界，没有仅凭搜索结果判定新的产品缺陷。
- REPORT #27补充进展。浏览器页面恢复不能替代Electron进程退出重开、磁盘profile及账户/项目/会话组合验收。整体目标继续active，官方API未接入仍不单列问题。

### 第九十二批：已打开窗口的服务配置同步

- 上一轮完成持久化新页面恢复，是实质进展。本轮把正式设置用例扩展至已打开原页面：另一页面清除密码之后再打开原页面编辑框，server-window-sync-before.txt失败，预期空、实际旧fixture密码，确认#29。
- persisted新增显式sync选项，仅ServerProvider的全局server记录启用。使用按平台存储类型、命名空间、key隔离的BroadcastChannel；写入完成再发布，接收后等初始读取完成再应用，避免旧异步初始值覆盖新配置；清理后不发布、不应用迟到消息。没有给窗口标签/草稿开启同步，也没有修改generated SDK。
- 生产修改前server-window-sync-baseline.txt三导航通过；修复后server-window-sync-after.txt六项通过（跨页面设置保存/清除/恢复及旧窗口回显、三导航、两缺失目标入口）。server-window-sync-comparison.json前后blank/unknown均0。App UI单元593pass/1609断言，App UI/Desktop类型检查通过。
- 为验证桌面环境，扩展独立router fixture的PersistenceProbe，直接导入产品persisted/PlatformProvider，使用自定义测试preload暴露异步IPC，主进程调用实际产品getStore。两个独立隐藏BrowserWindow、sandbox/contextIsolation、同类oc://renderer安全源与新磁盘profile，按钮操作a→b及b→a同步均正确，窗口私有记录不串，磁盘最终值b。
- native-persistence-sync-da4d1121/persistence-result.json passed（bidirectional/privateStateIsolated/diskValue），专用PID59184自然exit0，stderr空；native-persistence-sync-launch.json保存启动与终止信息。使用的是测试IPC适配而非完整产品preload/业务AppInterface，不夸大为完整桌面任务验收。无现有app/server重启。
- 格式化与最终类型检查完成；Beta构建desktop-build-server-window-sync.txt exit0，当前out包含本批，main-C-XIg7uH.js。REPORT新增#29。
- 整体目标继续active。原生异步初始读取竞态/退出时迟到写入、完整业务多窗口并发、账户/项目/会话组合磁盘恢复及发布签名仍需进一步证据；本轮不把单窗口持久恢复或持久层fixture替代这些门槛。官方API未接入不单独列错。

### 第九十三批：原生同步的初始读取与销毁竞态

- 上一轮#29为实质进展。本轮扩展独立Electron persistence fixture，主进程截留slow窗口实际getStore初始响应b，待另一个窗口写a且该窗口原生BroadcastChannel监视器确认收到a，再放行旧b。native-persistence-race-26d0af6e/persistence-result.json passed，最终a且ready=true，证明异步初始值没有覆盖新更新；专用PID11212 exit0。
- 继续截留写入IPC回复：真实getStore已保存closing，但renderer状态组件先卸载。第92批同步实现在onCleanup立即关闭通道并跳过publish，其他窗口没有收到最终更新。native-persistence-close-before-d8b2bb6d/pending-write.json证明disposed=true/diskValue=closing，随后等待对端DOM更新失败；PID34256 exit1。这是对前批新实现发现的边界缺口，并非新增无证据推测。
- 修改前persistence-close-baseline.txt三项生产导航通过。persisted同步生命周期增加在途写入计数：组件关闭后不再应用收到的消息，已开始的异步保存仍完成发布，最后一个写入结束才关闭通道；finally保证失败也释放计数/通道。未给其他配置开启同步，未改生成文件。
- native-persistence-close-fixed-b5f8f532/persistence-result.json通过双向同步、私有状态隔离、旧初始值竞态、组件卸载后的在途保存通知，最终对端值closing、无unhandledrejection；PID19372 exit0。测试只卸载持久状态组件、保留独立renderer以收取IPC回复，没有用此证明整个BrowserWindow/进程退出场景。
- persistence-close-browser.txt六项通过；App UI单元593pass/1609断言；App UI/Desktop类型检查通过。persistence-close-comparison.json三导航前后blank/unknown均0。
- Beta构建desktop-build-persistence-close.txt exit0，当前out包含本批main-ewzXGllb.js。REPORT #29更新边界与最新证据。没有重启现有app/server，全部native探针为新独立profile的隐藏测试进程自然结束。
- 整体目标继续active。下一步需要验证整个渲染进程退出/崩溃时共享配置提交后的通知保障，不能让renderer存活的组件卸载测试替代它；完整业务账户/项目/会话磁盘恢复和签名发布门槛仍开放。

### 第九十四批：渲染进程崩溃后的已提交配置通知

- 上一轮为实质进展：组件销毁时保留在途通知。本轮先验证普通BrowserWindow.destroy，native-persistence-exit-before-dc4f2c99通过；没有把此成功误报缺陷。随后确认源renderer OS PID与其他窗口不同，forcefullyCrashRenderer并等待render-process-gone/crashed后才释放已截留IPC回复：native-persistence-crash-before-8d01bfd1已落盘exiting，但对端等待更新失败，专用主进程exit1。
- 桌面新增writeStore提交/通知边界：真实getStore写入后立即通知IPC边界筛选出的可信renderer，排除发送源和已销毁目标，通知不再依赖源renderer收到写入回复。store-set实际handler接入该函数；preload增加onStoreWrite，Platform提供按存储名/key过滤的订阅，persisted优先使用平台提交通知。浏览器与旧preload保留BroadcastChannel兼容路径。
- 原生初轮使用测试preload的native-store-authoritative-d1b6c167通过；进一步用产品src/preload/index.ts实际构建的CJS桥接复核。native-store-production-9d0ce3a1/exit-result.json passed、phase=crash、productionPreload=true；renderer-crash.json记录PID46508/crashed/独立于其他窗口，源窗口销毁后对端值exiting，主测试PID64992自然exit0、stderr空。主IPC测试包装只用于截留回复，存储与通知调用产品writeStore/getStore。
- 产品preload复核最初一次构建调用handle50778终态exit-1且所有预期构建/启动输出均不存在；检查终态后重新执行构建，再创建唯一新测试profile。没有因观察超时重启任何现有测试或用户应用。
- 采用第93批persistence-close-browser.txt已有的、与本批生产修改前源码相符的三导航基准；store-main-browser.txt六项通过，store-main-comparison.json前后blank/unknown均0。App UI单元593pass/1609断言、desktop security-boundary七项/33断言及App UI/Desktop类型检查通过。
- Beta构建desktop-build-store-main.txt exit0，当前out包含本批main-ydLKY2jC.js。REPORT #29补齐进程边界证据，未重启现有app/server。没有把测试组件集成和preload验证冒充完整业务应用全链路。
- 整体目标继续active；完整账户/项目/会话组合磁盘恢复、安装签名和完整正常商业使用矩阵仍未全部验收。官方API未接入不单列问题。

### 第九十五批：完整桌面页面的组合磁盘恢复

- 使用未改动的第94批生产 out、新独立 Electron profile、真实 sidecar 与绝对路径 SQLite 数据库。没有使用 ZAOVRA_TEST_ONBOARDING 的内存数据库。新增 full-desktop-disk-entry.mjs 仅隔离 appData/XDG/DB 与测试调试端口。
- 首个独立实例 PID51184 被产品开发入口的固定9222覆盖调试端口，启动成功但无法通过指定端口调试；保留运行，没有重启。调整测试启动器后另建独立profile full-desktop-combined-4d97f0f2，PID56752/CDP61922，真实sidecar61925；两个新实例及已有应用均未重启。
- agent-browser实际检查页面。最初网络route账户响应缺少跨域处理，造成测试拦截的Failed to fetch；移除该拦截，改用既有isolated-account-fixture.js初始化脚本，账户门禁通过。Bun CDP连接超时后使用Node正式探针成功，未重启应用。上述为测试配置问题，未增加产品缺陷。
- full-desktop-combined-recovery.mjs以本地HTTP模型fixture完成真实/api/session创建、prompt与context请求，在同一独立profile写入项目列表/窗口标签/最后路由种子后重新加载renderer；实际AppInterface恢复Recovery Project、会话、用户消息及模型回复。源代码没有业务测试钩子，账户与模型响应为fixture，业务后端/SQLite/IPC/renderer均为真实产品。
- 扩展真实Prompt输入UNSENT_DISK_DRAFT_95，轮询实际.dat文件确认写入，再次重新加载renderer，断言文字完整恢复且历史回复与Send按钮存在。最终combined-result.json passed、unsentInputRecovered=true、pageerrors=[]；combined-recovered.png人工查看通过。两次renderer reload期间主进程/sidecar始终保留，不等同整应用退出恢复。
- 扩展用例首次重跑复用了旧项目及其已缓存的临时模型端口，provider请求未完成；最终为每次运行创建独立项目目录，避免临时provider端口变化污染测试。最终full-desktop-combined-recovery.txt exit0，sessionID ses_combined_1788979928726；数据库使用真实SQLite/WAL，非仅内存。
- 本批没有修改产品代码，不重复构建或运行与本批无关的全量单元测试，当前out仍main-ydLKY2jC.js。账户真实登录/整进程组合恢复、安装签名及完整商业使用矩阵仍开放，整体目标保持active；官方API尚未接入不单列问题。

### 第九十六批：恢复后执行闭环与Git子目录差异修复

- 上一轮为实质进展。本轮扩展full-desktop-combined-recovery.mjs --workflow，以恢复后的真实输入框发送，受控模型只发一次write调用；审批前文件不存在，UI允许一次之后才写入，随后完成回复、renderer加载后输入为空且工具结果仍在。
- 使用实际产品Identifier生成测试message/session ID，避免手写非时间排序ID改变历史顺序；audit-identifiers.mjs由app-ui/src/utils/id.ts构建，不在测试复制算法。测试等待实际audit-model按钮再发送，诊断确认此前过早发送触发了模型未加载提示，非后端丢失请求。
- 撤销操作先hover消息显露动作按钮；此前直接点击隐藏的pointer-events:none动作超时属于测试交互错误。等待真实revert.stage=200/clear=204完成后才检查磁盘，避免把乐观UI当作文件操作完成；此前即时磁盘断言及clear错误预期200均为测试问题。
- 同一链路验证：恢复未发送输入→UI发送→真实权限审批→工具写入→重新加载→撤销（文件消失）→再次加载仍有回滚消息→恢复消息（文件内容恢复），providerTurns仅一条tool=true、pageerrors=[]。原实例full-desktop-combined-4d97f0f2完整执行通过。
- 继续实际点击审查文件，发现纯文本显示“二进制文件”；这是本轮新增产品缺陷#30，不因前述执行链通过而忽略。新增packages/zaovra/test/project/vcs.test.ts真实嵌套项目测试，修改前vcs-nested-before.txt失败，新增文本additions=0/空patch。
- Vcs.diff/branch/detail和diffRaw统一从ctx.worktree解析Git返回的仓库相对路径；查询仍在ctx.directory，保持当前子目录范围，不混入外部文件。产品修改仅project/vcs.ts，未修改UI、会话或公共协议。
- 修复后vcs-nested-after.txt 22pass/51断言，覆盖tracked/untracked文本、raw及范围隔离；vcs-nested-typecheck.txt exit0。格式化完成，Beta构建desktop-build-vcs-nested.txt exit0，当前out包含新后端，renderer仍main-ydLKY2jC.js。
- 未重启原应用或服务器；另建独立新版profile full-desktop-vcs-7ad8aa92，PID51752/CDP64371。full-desktop-vcs-workflow.txt exit0（8.0s），combined-workflow-result.json passed，正式用例在撤销恢复后实际点击审查文件并等待“Recovered desktop task completed.”；人工检查combined-workflow.png确认+1行、真实文字，不再显示二进制。
- 新版账户与模型为fixture；真实业务后端/SQLite/工具/IPC/UI完整工作。整体目标仍active，安装签名、整应用退出组合恢复及其余商业矩阵仍需证据。官方API尚未接入不单列问题。下一轮可继续检查子目录项目中审查的媒体读取/打开文件路径是否同样存在相对基准差异，不先把推测列为缺陷。

### 第九十七批：子目录审查媒体读取与加载依赖

- 上一轮为实质进展，#30已修复。本轮在仍存活的PID51752/CDP64371上继续审查，为其独立项目添加1像素PNG。实际UI加载失败，nested-media-before.png与正式nested-media-before.txt保存失败；fixture Image.decode成功，故非损坏图片。记录到directory=子项目、path=仓库相对路径的错误组合。
- 按AGENTS在会话页面修改前记录review-media-baseline.txt生产三导航基准（此前App UI产物与当前未修改前UI一致）。新增review-file-path.ts/.test.ts，保留绝对路径和文件名字面字符，从项目worktree转换审查路径；V2/旧审查读取均接入，旧打开文件回调同时转换。后端目录安全检查不变；未改SDK生成代码。
- 首次手动bun test --conditions=browser src没有项目规定的happydom preload，6项原有ServerSession测试失败；纠正为bun run test:unit，review-media-app-unit-final.txt 595pass/1616断言。App/Desktop类型检查通过。React技能清单已读取，仅采用与Solid代码相符的一般依赖/性能检查，不引入React hooks。
- 路径修复初版构建desktop-build-review-media.txt通过，另建独立profile full-desktop-media-e9493ab1，PID58864/CDP65210；原有实例未重启。full-desktop-media-workflow.txt完整恢复/发送/审批/写入/撤销/恢复/文本审查通过。
- PNG正式用例在初版仍失败（nested-media-after.txt）：实际接口200且binary/base64/image/png，路径已正确，但一秒内5次/file/content、没有其他请求，UI持续加载。进一步将FileMedia的副作用明确限定为on(request, callback)，避免SDK/path解析中读取的响应式状态成为加载依赖。这是当前修复过程需要补齐的边界，不声称已证明独立历史缺陷。
- Session UI测试76pass/180断言及类型检查通过。最终desktop-build-media-lifecycle.txt exit0，renderer main-DxGvpbpQ.js。对同一PID58864只重新加载renderer，主进程/sidecar保持运行；nested-media-lifecycle-after.txt通过。正式用例再加PNG读取次数严格为1的断言，nested-media-final.txt exit0（2.2s），nested-media-result.json passed/decodedWidth1/requests1/errors[]；独立频率采样无追加读取。
- 导航最终review-media-lifecycle-after.txt三项通过，review-media-final-comparison.json前后blank/unknown均0，单次小样本不宣称性能提升。没有修改网站、第三方库、公共API或重启任何应用/后台。
- REPORT新增#31。PNG媒体闭环有真实产品证据；旧布局打开文件路径转换有代码/类型验证，尚不冒充该入口实机验收。安装签名、整应用退出组合恢复及其余商业矩阵仍开放，整体目标继续active，官方API未接入不单独列错。

### 第九十八批：预览切换竞态与双窗口真实审批/回滚同步

- 上一轮为实质进展：#31图片读取和加载依赖已修复。本轮先确认独立QA PID58864仍存活，扩展nested-review-media.mjs：图片/文本往返两次，每次图片正确解码，文本状态没有旧图片；三次选择图片严格三次读取。
- 正式探针截留实际图片HTTP回复，切到文本后才交付旧图片回复，等待浏览器渲染帧后确认图片没有重新出现，文本保持。nested-media-switching.txt exit0，nested-media-result.json记录switchingCycles=2/staleImageIgnored=true/errors=[]。没有改服务端返回值，只有测试层控制到达顺序；读取次数断言保留。
- full-desktop-combined-recovery.mjs新增--multiwindow：通过产品runDesktopMenuAction(window.new)创建第二个真实BrowserWindow，使用不同windowID、同一真实Session/sidecar及磁盘数据库；仅测试目标标签/路由及账户响应作fixture设置。
- 两个窗口均收到真实write权限请求，审批前文件不存在；在第二个窗口点击允许一次，两个窗口清除审批并显示实际完成回复，磁盘内容正确，providerTurns仅一次tool=true。随后原窗口撤销，两个窗口出现回滚状态且文件消失；原窗口renderer加载后恢复，两边恢复回复且文件内容一致，实际审查仍显示文本。
- full-desktop-multiwindow-final.txt exit0（9.3s），full-desktop-media-e9493ab1/combined-multiwindow-result.json passed，原window f305a11e-759d-495e-b886-707d537a5bb6与peer 977c2005-f481-4f10-90a9-abdcf7023432不同，无pageerror。探针仅关闭自己新建的peer窗口；原主窗口、主进程及sidecar未重启。首轮结束后实际getWindowCount=1/PID58864存活，最终同样经过peer.close清理。
- 本轮没有产品改动，无需重复构建/全量单元检查。当前out仍第97批main-DxGvpbpQ.js。package:check通过（8个必要输入及内嵌服务chunk存在），明确不等同安装签名或升级验收。
- REPORT补充第1/3/31项组合验证。本轮未发现新增产品缺陷；没有声称两个窗口未发送草稿必须实时同步，测试未修改第二窗口草稿。完整安装/退出组合恢复等剩余商业门槛仍开放，整体目标active；官方API未接入不单独报错。

### 第九十九批：Windows 发布者约束与更新校验

- 收尾核对第21项，确认 verifyUpdateCodeSignature 仍为 false。已开启校验，读取并 trim WINDOWS_SIGNING_PUBLISHER_NAME，传入 signtoolOptions.publisherName；Windows CI 实际签名入口缺少名称即失败。publish.yml 的 build-electron 从同名仓库变量传入，不虚构真实发布者。
- sign-windows.ps1 将发布者纳入必填参数，空白也拒绝；签名后既检查 Authenticode Valid，也要求实际证书 CN 或完整 Subject 与所配名称大小写准确匹配。其他签名目标检查保留，没有更改证书库或调用实际 Azure 签名。
- 首轮11项中1项断言失败，原因是PowerShell错误文本换行，原断言跨越换行；改为检查两个独立关键片段。windows-publisher-tests-final.txt 11pass/35断言，windows-publisher-typecheck.txt exit0。实际解析发布工作流确认变量引用正确，git diff --check通过。
- windows-update-signature-probe.mjs直接调用已安装electron-updater的真实Windows校验函数，对不可执行的未签名测试样本运行实际Get-AuthenticodeSignature，返回非空拒绝结果；windows-update-signature-probe.txt passed。没有mock签名结果，没有执行测试.exe；Node报告来自依赖shell调用的弃用提示，探针exit0。不将该负向验证冒充真实已签名安装包成功验证。
- 本批只改打包/签名配置与测试，未修改运行时UI，不重复构建现有运行产物，未重启任何应用或服务。当前out仍第97批。准确证书Subject/CN及真实签名、安装、升级验收仍待；本地缺少publisherName的未签名开发包不算可信更新链路。REPORT第21项更新为配置已补齐、真实发布待验收，整体目标继续active。

### 第一百批：实际NSIS产物与更新元数据一致性

- 上一轮为实质进展，本轮验证第21项配置能否进入实际产物。独立输出目录package-publisher-100的Windows x64 --dir构建exit0；该模式没有app-update.yml，检查已安装PublishManager确认Windows只在适用安装目标生成更新配置，未将正常工具行为列作缺陷。
- 完整NSIS初轮package-publisher-nsis-100.txt在下载Electron时明确ETIMEDOUT并exit1；等待并确认原session42119终止后才开始新尝试，没有因观察超时重启。第二轮指定项目已安装的同版本Electron dist，输出仍在独立quality目录，--publish never、GITHUB_ACTIONS=false和Fixture Publisher，不触发实际发布或安装。
- package-publisher-nsis-local-100.txt exit0，生成124657367字节NSIS安装包及blockmap。实际win-unpacked/resources/app-update.yml含channel=beta和publisherName=[Fixture Publisher]；verify-package-publisher.ts读取真实文件，验证beta.yml的安装包路径、大小和SHA-512与实际安装包一致，package-publisher-result.txt passed/updateManifestMatches=true。
- 日志的signing with signtool文本是构建器调用自定义签名函数时的日志，本地GITHUB_ACTIONS=false会跳过签名，不能据此声称真实签名成功。测试产物不作为正式发布包，没有安装、没有改证书库、没有启动或重启应用。
- 本批未修改产品源码。第21项的打包元数据证据已补齐，准确真实证书名称、签名成功路径、安装升级及整应用退出组合恢复仍需证据，整体目标active，官方API未接入继续排除。

### 第一百零一批：交付产物的真实业务执行

- 上一轮为实质进展。本轮直接启动第100批win-unpacked/Zaovra Beta.exe，日志确认packaged=true、Beta更新渠道及内嵌sidecar就绪。独立PID63664/CDP58956/sidecar58960，ZAOVRA_TEST_ONBOARDING=1隔离新profile，数据库明确为memory；没有将此证据用于跨进程数据库恢复，也未安装或重启原有实例。
- 正式组合探针增加可选DESKTOP_AUDIT_LAUNCH、desktopPath与显式memory模式，默认既有磁盘测试仍要求真实sessions.db。使用同一实际产品后端、preload、UI及本地账户/模型fixture，完成历史/未发送输入renderer恢复、发送、审批、工具写文件、撤销、恢复。
- 初轮最终找不到recovered-task.txt按钮。agent-browser实际snapshot证明“切换审查”aria-expanded=false；新实例默认收起面板，而此前测试实例已有展开状态。用例加入正常点击展开，不改产品。初轮失败保留packaged-workflow-101.txt，不将测试前置条件列作bug。
- packaged-workflow-final-101.txt exit0（8.7s）；packaged-workflow-101/combined-workflow-result.json passed，session ses_f78441efeffeFZrQRHNj80wNfM、errors=[]、unsentInputRecovered=true，providerTurns只有一次tool=true。截图人工确认正式审查显示真实新增文本与+1行。主进程仍存活，测试只进行renderer加载与CDP断开。
- 本批没有产品改动，未重复构建。证明的是已打包可执行产物业务工作，不是NSIS安装/卸载或真实签名升级；完整退出重开组合恢复仍开放。整体目标active，官方API未接入继续排除。

### 第一百零二批：打包实例提问与待回答恢复

- 上一轮为实质进展。确认PID63664仍存活，沿用同一打包实例；组合探针新增--question，本地模型先调用真实question工具，再根据实际工具回答继续write。UI正常选择Proceed fixture并提交，后续真实provider请求含该回答。
- 初轮已完成回答与写入，但旧断言要求所有工具调用总数为1，新增question后总数为2因此失败。改为严格检查write调用一次（排除asking），并新增answerReceived恰好一次断言；不改产品、不放宽文件副作用检查。packaged-question-final-102.txt exit0。
- 继续在问题出现、文件尚不存在时重新加载renderer，等待真实待回答问题恢复，再通过radio选择及提交。packaged-question-reload-102.txt exit0；packaged-question-result-102.json passed、errors=[]、memory数据库显式记录。随后真实写入审批、文件检查、撤销恢复及Git审查全部通过。combined-question-pending.png保存待回答UI。
- 此次只重新加载renderer，主进程/sidecar保持运行，账户/模型为fixture；不是整进程退出恢复证据。没有新增产品缺陷，没有重建未修改产物。完整签名安装升级、整应用退出组合恢复等门槛仍开放，整体目标active，官方API未接入不单独报错。

### 第一百零三批：多问题与多选答案端到端一致性

- 上一轮为实质进展。本轮确认原打包PID63664仍存活，新增--multi-question组合场景：真实question包含一题单选、一题多选，待回答时renderer重新加载，UI选择第一题并下一步、选择第二题两个选项、提交。
- 在真实POST question reply请求上断言answers严格等于[[Proceed fixture],[Read check,Diff check]]，检查题序和多选完整性；后续实际provider请求的工具输出明确包含两题对应回答。没有mock业务reply接口或替换产品状态。
- 首轮完成业务流程后测试记录检查对没有answerOutput的普通provider turn调用includes，触发TypeError；仅修复测试空值处理。packaged-multi-question-final-103.txt exit0，packaged-multi-question-result-103.json passed、errors=[]，后续审批、write一次、撤销恢复和审查保持通过。未新增产品缺陷。
- 本轮没有产品改动或重建，没有重启主进程/sidecar。账户/模型fixture、内存数据库及renderer恢复边界同第101/102批，不能据此宣称完整退出恢复或签名升级通过。整体目标active，官方API未接入继续排除。

### 第一百零四批：拒绝审批后消息未结束（新增#32，已修复）

- 上一轮为实质进展。本轮在打包PID63664双窗口执行拒绝write。初轮预期模型继续回复失败；核对runner明确规定用户拒绝直接中断，修正测试语义。第二轮等待Send仍失败，真实DOM持续Stop/思考中，证明另有产品问题；不是把初轮语义假设当作缺陷。
- packaged-denial-state-104.json实际context显示工具已error/completed，但所属assistant没有time.completed/finish。llm.ts的isUserDeclined分支在failUnsettledTools后直接Effect.interrupt，跳过消息结束投影。新增原有拒绝回归的finish=interrupted及完成时间断言，declined-runner-before-104.txt失败。
- 产品修改仅在拒绝分支中断前调用既有settleInterruptedTurn，并经withPublication串行发布；保持拒绝终止模型循环的语义，不生成额外provider请求。测试初版用Number匹配内部DateTime不正确，改为完成时间存在性；缺失finish的红灯证据仍有效。declined-runner-suite-104.txt 88pass/269断言，Core类型检查和diff检查通过。
- desktop-build-declined-104.txt exit0，renderer仍main-DxGvpbpQ.js，修复位于内嵌Core服务。独立package-declined-104的--dir实际打包exit0，启动全新隔离打包实例，原app/server没有重启。packaged-declined-104-launch.json记录新PID/端口；内存测试数据库明确。
- packaged-denial-fixed-104.txt exit0（6.4s），packaged-denial-fixed-104/combined-multiwindow-result.json passed/errors=[]。第二窗口拒绝后两边审批消失/Send出现；文件始终不存在，主窗口renderer刷新后失败记录仍在且可输入；providerTurns只有初始回复和write请求，无拒绝后的额外模型调用。测试只关闭自身新建peer窗口。
- 正式组合测试增加--deny-write分支，其余允许写入/提问场景保持原断言。当前源码和新隔离产物已修复#32；旧第100批安装包不含此修复，不可作为最新交付包。完整签名安装升级及整应用退出恢复仍开放，整体目标active，官方API未接入继续排除。

### 第一百零五批：拒绝后的同会话继续与允许路径回归

- 上一轮为实质进展，#32修复。本轮确认新版打包PID39036仍存活，扩展拒绝分支：两窗口回空闲、原窗口renderer刷新之后，在同一Session通过真实Prompt发送新消息，模型返回独立标记，两个窗口均显示该回复；先前被拒绝的文件仍不存在，没有自动重做旧工具。
- packaged-denial-followup-105.txt exit0（6.3s），packaged-denial-followup-result-105.json passed/errors=[]；provider总请求从拒绝时2次增至新任务后3次，旧write请求仅一次。此证据验证会话后续可用性，不只检查Send按钮出现。
- 同一新版实例运行允许路径组合回归（--workflow --question --multi-question --multiwindow）：问题renderer恢复、单选/多选提交请求精确匹配、模型收到完整回答、另一窗口允许write、两窗口完成、撤销恢复及实际Git审查通过。packaged-allow-regression-105.txt exit0，packaged-allow-regression-result-105.json passed/errors=[]。
- 没有新增产品修改或构建；只关闭每次探针创建的peer窗口，原应用和服务未重启。数据库memory/账户模型fixture边界明确；没有宣称签名安装升级或整应用退出恢复完成。整体目标继续active，官方API尚未接入不单列问题。

### 第一百零六批：跳过提问后的等待请求未收敛（新增#33，待修复）

- 上一轮为实质进展。本轮确认新版PID39036存活，扩展--reject-question双窗口场景：真实question出现后原renderer加载、第二窗口点击“忽略”，两窗口问题消失，但原窗口等待Send超时。packaged-question-reject-106.txt失败，未把该场景算通过。
- inspect-question-reject-106.mjs读取实际业务context与active：assistant已有time.completed/finish=interrupted，工具error/completed，active.data为空；question-reject-state-106.json证明第32项消息收尾已生效。实际UI仍思考中/Stop，见question-reject-ui-106.txt。
- 增加请求/响应/失败诊断后再次复现，packaged-question-reject-network-106.txt失败。question-reject-network-106.json保存本次原窗口的wait请求：结束前发起的请求在30秒观察内既无response也无requestfailed，之后未出现watchExecution所需的active核对。不能仅因active为空就认定UI正确。
- 源码核对：server-session.watchExecution先await wait再查active；服务端session.wait只用Effect.catch处理typed error，底层coordinator将drain的interrupt退出传播给等待者。中断响应是否在HTTP层未完成是当前待验证原因，尚未直接修改该逻辑或把推测写成已证实根因。
- 本批只扩展测试/诊断，未修改产品或重建；新旧进程均未重启，探针peer在finally关闭。下一步补真实等待接口的中断回归，再修复并复测跳过后同会话继续。#33仍开放，整体目标active，官方API未接入继续排除。

### 第一百零七批：等待者继承执行中断（#33已修复）

- 上一轮为实质进展，本轮在SessionRunCoordinator补充实际Effect回归：执行自行中断时观察等待者应成功结束；取消观察等待者仍应中断其自身且不影响执行。修改前第一项失败，第二项初版使用不存在的Exit.isInterrupted导致测试错误，已改为Exit.isFailure/Cause.hasInterruptsOnly，未将测试API错误列作产品缺陷。
- coordinator原来让wait与run共用失败/中断Deferred，导致观察者继承执行所有者的中断。现保留run/exclusive原done语义，新增承载Exit值的observed完成信号；wait仅将执行的纯中断转为已结束，其他退出仍传播，等待者自己的取消仍作用于其Deferred.await。没有修改公共协议或生成客户端。
- wait-interruption-after-107.txt共108pass/301断言，Core类型检查通过，格式化完成。原有并发resume、pending wake、独占操作、不同Session并行以及runner拒绝语义测试均通过。未改前端、未加入轮询补丁。
- desktop-build-wait-107.txt和package-wait-107.txt均exit0。启动全新隔离打包PID46584/CDP55019/sidecar55026，原实例均未重启；packaged-wait-107-launch.json保存profile（memory测试数据库）。当前out后端含#32/#33，renderer仍main-DxGvpbpQ.js。
- packaged-question-fixed-107.txt exit0（7.7s），packaged-question-fixed-107/combined-multiwindow-result.json passed/errors=[]。原窗口问题等待期间renderer加载，第二窗口忽略，两边问题消失/Send恢复；刷新后失败记录存在，同Session新任务两窗口都收到回复，未调用write或创建文件。
- combined-execution-requests.json记录实际wait=204后active=200，不再停在等待请求；204响应后的ERR_ABORTED事件为浏览器请求收尾记录，UI已继续完成，不能据此误报业务失败。没有发布、安装或重启已有进程。#33修复完成，整体商业目标仍active，真实签名升级和完整退出恢复等证据仍缺。

### 第一百零八批：流式输出改写历史显示（新增#34，待修复）

- 上一轮为实质进展。本轮确认PID46584仍存活，扩展--stop-stream：本地provider只写出STREAM_STARTED_108且保持SSE连接，计划验证用户Stop关闭连接、双窗口空闲及同Session后续任务。
- 首轮在Stop前的文本定位出现两个匹配；加入visible过滤后仍有两个，不能当作隐藏DOM或直接first绕过。第三轮先截图与保存祖先节点再保留严格断言，packaged-stop-stream-diagnostic-108.txt失败。
- packaged-question-fixed-107/stream-started.png人工确认：第一条原本COMBINED_DISK_RESPONSE_95历史回复被显示为新STREAM_STARTED_108，同时当前回复也显示STREAM_STARTED_108。stream-nodes.json记录两个不同session-turn下的可见Markdown，非同一节点重复选择。
- 源码openai-chat/gemini流式text ID复用text-0，UI V2事件映射直接使用该ID，server-session的deltaBases/part_text_accum_delta按part ID全局索引，存在跨message作用域冲突。后端历史是否保持正确及适配/缓存完整修复仍需进一步回归，未先改产品或宣布最终根因闭环。
- Stop本身尚未执行，测试在前置显示断言失败后finally关闭测试provider及自身peer，不能声称用户Stop链路通过；原主进程和sidecar未重启。本批无产品修改，下一步先按AGENTS记录生产导航基准，再补跨消息文本ID复用回归并修复#34。整体目标active，官方API未接入继续排除。

### 第一百零九批：跨消息片段ID隔离与Stop闭环（#34已修复）

- 上一轮为实质进展。新增历史/当前回复复用text-0的store回归，修复前明确两者part.id相同。初始fixture缺少user使历史未加载，补齐真实消息序列；stream-isolation-before-final-109.txt记录ID冲突红灯。
- 修改前生产导航首轮默认Playwright缺少指定浏览器版本，三项没有运行成功；使用既有审计配置中的已安装Chromium和已构建未修改UI，stream-isolation-baseline-final-109.txt三项通过。没有修改产品来绕过测试环境。
- adaptPartID以messageID限定界面part ID，历史text/reasoning/tool转换与实时text/reasoning的start/delta/end使用同一规则；tool.callID仍保持原始调用标识。避免全局增量缓存/Markdown缓存将重复provider text-0视为同一片段，不修改服务器数据或公共API。
- 直接--conditions=browser运行产生既有Solid proxy匹配差异，正式按项目bun run test:unit验证：stream-isolation-unit-109.txt 596pass/1620断言。测试helper显式缩窄assistant返回类型后App类型检查通过；Desktop类型检查也通过。格式化和diff检查完成。
- 修改后生产导航stream-isolation-benchmark-after-109.txt三项通过；stream-isolation-comparison-109.json六条前后记录blank/unknown均0，不以小样本宣称性能提升。
- desktop-build-stream-109.txt/package-stream-109.txt exit0，新renderer main-DQRDlDyc.js。另建隔离打包实例，packaged-stream-109-launch.json记录PID/端口；所有已有app/server未重启。实际stream-started.png确认旧COMBINED_DISK_RESPONSE_95保持原文，新STREAM_STARTED_108只显示一次，两窗口严格文本检查通过。
- 首次后续Stop点击定位失败：peer保留测试种子未发送草稿，没有Stop按钮；改从截图中实际显示Stop的原窗口操作，不改产品。packaged-stream-final-109.txt exit0（5.7s），流式provider连接在点击Stop后实际close（在finally清理前验证），两窗口Send恢复，renderer加载后已输出文本保留，同Session新任务两窗口正确回复，未产生文件。
- 第34项已修复，Stop业务闭环也完成；当前out及package-stream-109含本修复，旧安装包不含最新修改。账户/模型fixture与memory数据库边界不变，签名安装升级、整进程退出恢复等商业门槛仍开放，整体目标active。

### 第一百一十批：片段隔离后的工具与业务回归

- 上一轮为实质进展，#34修复。本轮确认PID42660仍存活，使用同一新版打包实例重跑--workflow --question --multi-question --multiwindow，验证原始工具标识保留后正式业务是否一致。
- packaged-scoped-parts-regression-110.txt exit0，scoped-parts-business-result-110.json passed/errors=[]；多问题回复数组严格匹配、后续模型收到答案、第二窗口允许审批、实际write、双窗口撤销恢复及Git文字审查全部通过，write仅一次。
- 增加适配层回归，两个assistant复用reasoning-0和call-0时四个界面part ID唯一，而两工具callID仍都是原始call-0。scoped-parts-unit-110.txt 597pass，scoped-parts-typecheck-110.txt exit0。
- 本批只增测试，无产品代码改动，不重复构建已有产物，未重启任何app/server；探针只关闭自身peer。当前最新产物仍第109批main-DQRDlDyc.js。完整签名安装升级、整应用退出恢复等商业验收仍开放，整体目标active；官方API未接入继续排除。

### 第一百一十一批：运行中steer追加任务闭环

- 上一轮为实质进展。本轮确认新版PID42660仍存活，扩展--followup-stream：本地provider发出一段真实SSE文本后保持连接，UI输入FOLLOWUP_PROMPT_111并正常Send。正式POST prompt返回200，followup-admission-111.json确认delivery=steer。
- 在追加请求完成、原provider尚未放行结束帧时，严格确认provider请求仍为2次（初始回复与当前流式回复），没有并行启动第二个模型执行。随后测试provider发送正常结束帧，真实runner在安全边界处理已接收指令，两个窗口显示FOLLOWUP_RESPONSE_111，总provider请求3次。
- 原窗口renderer加载后，初始历史回复、部分流式文本和追加回复都保持正确，追加用户消息恰好一条。packaged-followup-final-111.txt exit0（6.4s），followup-business-result-111.json passed/errors=[]。测试没有模拟业务admission/runner结果，只控制模型流到达时序。
- 本批仅扩展测试，无产品改动或重建，没有重启已有进程；只清理自己创建的peer与provider。已验证的是默认steer，不把它当作显式queue等待整任务空闲的证明。完整签名安装升级与退出恢复等门槛仍开放，整体目标active，官方API未接入继续排除。

### 第一百一十二批：设置选择框被aria-hidden与显式队列（新增#35，已修复）

- 上一轮为实质进展。本轮通过真实设置UI选择排队时option定位超时；queue-settings-dom-112.json证明SelectV2已经expanded，但两个可见选项的祖先aria-hidden=true。不是点击错控件，也没有用includeHidden/force绕过；queue-settings-112.png保存现场。
- SelectV2直接使用Kobalte.Content，遗漏此前MenuV2已有的data-kb-top-layer标记。补齐该属性，使父modal识别选择框浮层。产品仅修改ui/src/v2/components/select-v2.tsx一行，不修改第三方库或业务协议。
- 修改前select-layer-baseline-112.txt三导航通过，修改后select-layer-benchmark-after-112.txt三导航通过；select-layer-comparison-112.json保留前后summary。UI类型检查通过，desktop-build-select-112.txt/package-select-112.txt exit0，新renderer main-C2VcvvrM.js。
- 新独立打包实例使用packaged-select-112-launch.json记录，原app/server未重启。正式--queue-followup用例通过设置控件选择排队，经过renderer加载后实际prompt请求仍delivery=queue/200，证明设置进入实际业务调用。
- 原模型流输出期间发送队列指令，返回admission后模型请求仍2次；原流随后发起真实question工具，队列回复仍不存在/模型请求仍2次。UI回答原任务问题后，原任务继续完成，再执行排队指令，总provider请求4次，双窗口结果一致，刷新历史完整且排队用户消息恰好一条。
- packaged-queue-fixed-112.txt exit0（8.1s），packaged-queue-fixed-112/combined-multiwindow-result.json passed/errors=[]，followup-admission.json记录queue。证明显式queue不会在需要继续的provider-turn边界提前执行，不把steer测试替代它。#35已修复，整体目标active，真实签名安装升级与完整退出恢复等门槛仍开放。

### 第一百一十三批：取回编辑并取消排队指令

- 上一轮为实质进展。本轮确认PID38356仍存活，按实际产品入口验证取消：SessionFollowupDock没有独立删除按钮，“编辑”先取消后端admission再取回输入。测试不虚构删除控件。
- --cancel-queue在原模型流保持活动时实际发送queue，随后点击排队dock的编辑，等待真实input/:id/cancel成功响应、输入框恢复原文字，再清空。两窗口dock均消失；没有仅凭乐观UI认定取消成功。
- 继续放行原任务的question步骤，回答后当前任务正常完成，provider总请求仅3次（初始回复、原任务流、原任务后续），被取消队列没有触发第4次调用。renderer加载后原任务回复仍存在，原排队提示/回复都不存在、dock保持隐藏。
- packaged-queue-cancel-113.txt exit0（7.5s），queue-cancel-result-113.json passed/errors=[]。只使用现有最新第112批产物，没有产品代码修改或重建，原app/server未重启；测试peer及provider按原finally清理。数据库memory和账户/模型fixture边界不变，整体目标active，完整签名安装升级与退出恢复等验收仍开放。

### 第一百一十四批：排队指令编辑后重新发送

- 延续质量验收，使用现有第112批打包进程PID38356，不重启app或server。扩展实际业务探针--edit-queue：原任务流活动时发送queue，通过真实编辑按钮取消旧admission并取回输入，修改文字再通过Send重新提交。
- 真实新prompt请求成功且delivery=queue，queue-edit-admission-114.json记录修改后的内容。原任务仍经过question工具并继续完成，随后新排队指令执行；provider总请求4次，捕获的provider最后用户消息中旧指令0次、新指令1次。
- 双窗口收到最终结果；renderer加载后修改后的用户消息恰好一条，旧指令不存在，历史和原流式文本保留。packaged-queue-edit-114.txt exit0，queue-edit-result-114.json passed/errors=[]；queue-edit-requests-114.json保留请求证据。
- 本批未发现新产品缺陷，仅扩展验收探针，无产品修改或重建。memory数据库及账户/模型fixture边界保留，不能替代整应用退出恢复或真实签名安装升级验收。官方API未接入继续排除，整体目标active。

### 第一百一十五批：运行中刷新暴露流式内容恢复缺口（新增#36，待修复）

- 上一轮为实质进展。本轮确认现有PID38356存活，新增--reload-queue，在真实queue admission成功后保持provider流活动并刷新renderer。原排队dock成功恢复，但已显示的STREAM_STARTED_108未恢复，packaged-queue-reload-115.txt在严格可见文本断言失败（进程exit1）。没有重启app/server。
- 代码证据：schema/session-event.ts明确Text/Reasoning.Delta为live-only；runner/publish-llm-event.ts仅在片段结束或flush时发布全值Ended；session/projector.ts只注册Started/Ended投影；SessionStore.context直接读取数据库投影。因此活跃片段在新窗口/renderer重新加载时无法从context恢复，直到Ended出现。这是实际流式可用性缺口，不归因于官方API。
- 下一步需补齐活动流的快照/恢复机制，并覆盖text/reasoning与快照和后续delta衔接，保持完成事件的语义和runner历史边界，避免简单把每个token写入durable日志或伪造Ended事件。
- 增补后端context与截图采集后第二次探针在更早的prompt admission等待超时：packaged-queue-reload-evidence-115.txt，未到context采集步骤，故没有生成新的snapshot证据。不得把这次失败当成同一根因的再次复现，也不能把旧result.json作为本批通过结果。需检查该独立等待问题后继续红绿验证。
- 本批新增可执行失败用例及问题定位，无产品修改。#36仍开放，先前35项修复记录不变；签名安装升级和整进程恢复门槛继续开放，整体目标active。

### 第一百一十六批：第36项后端活动快照实现（修复进行中）

- 上一轮为实质进展。本轮先记录live-snapshot-baseline-116.txt生产导航3通过。新增真实Core投影回归：已发布text/reasoning增量但未Ended时，重新调用messages/context/message应看到已生成内容。live-snapshot-red-116.txt 8pass/1fail，失败为两片段仍空字符串。
- 新增SessionLive全局服务，监听实际事件维护仅活动assistant的文本/推理快照，Step.Ended/Failed清理；capture保留不可变读取前快照，合并读取后快照，持久化完成内容优先于较旧前缀。SessionStore.context/message与SessionV2.messages接入，runnerContext保持持久化读取。没有新增durable token日志、伪造Ended或改动公共协议。
- 后端绿测9pass；扩展回归发现旧跨进程测试把运行中的context当成纯持久化快照。fixture现分别保存实时context与实际SessionHistory.load得到的durableContext，明确实时含PARTIAL_RESPONSE、持久化不含、崩溃后严格等于durableContext。首次新增fixture读取遗漏Database服务导出导致测试自身失败，补齐LayerNode.group的Database.node后通过。
- live-snapshot-regression-final-116.txt 106pass/379断言，Core typecheck exit0，格式化和diff检查完成。修改后导航live-snapshot-navigation-after-116.txt 3通过；本批renderer未修改，导航使用同一现有生产UI，不能作为Core流式性能证明。
- 第36项尚未完成：仍须处理前端历史快照和在途delta交错导致的重复/丢前缀，增加并发读取与清理验证，再构建新隔离桌面实例验证115失败链路。未把当前后端半成品打包或声称桌面已修复。现有app/server未重启，当前运行产物仍112；整体目标active。

### 第一百一十七批：第36项快照与增量衔接（待桌面验收）

- 上一轮为实质进展。修改前live-merge-baseline-117.txt生产导航3通过。新增前端实际store回归证明快照hello world后收到offset=5的 world会错误显示hello world world：live-merge-red-117.txt失败。
- Schema Text/Reasoning.Delta增加可选offset（UTF-16前缀长度），publisher按实际片段长度产生位置，不改变live-only与Ended持久化语义。旧无offset事件沿用旧路径；Client生成与legacy SDK正式build均exit0，没有手改generated文件。
- 前端对有位置增量按已有长度去重；缺少前文或消息尚未加载的增量暂存，历史返回时按位置补齐。窗口缓存淘汰、part删除、片段Ended清理缓冲；迟到Started不覆盖已存在的历史片段。刷新请求等待当前读取完成再执行，避免合并到旧inflight而漏掉新快照。
- 回归覆盖快照已含增量、读取旧快照过程中新增增量、增量早于首个快照；live-merge-final-unit-117.txt 600pass/1625断言，App类型检查通过。Core检查实际32个text/reasoning增量offset准确且没有durable delta日志，live-merge-core-final-117.txt 97pass/296断言。新增检查的unknown事件data类型守卫修正后Core类型检查通过。
- 修改后生产UI重新构建并导航测试live-merge-navigation-after-117.txt 3通过。第36项尚未关闭：仍需后端并发读取/清理补充验证及新的隔离打包桌面115链路红绿验收，并检查115第二次更早admission等待失败。当前运行桌面仍112，未重启任何现有app/server。整体目标active。

### 第一百一十八批：第36项桌面刷新与后续增量验收通过

- 上一轮为实质进展。本轮新增SessionLive并发读取/清理验证：读取闭包取得更新后的活动文本、Step.Failed后当前缓存清空而既有读取保留已捕获前缀、较新持久化全值不被旧前缀覆盖、不同message ID不串文。live-snapshot-cleanup-118.txt 10pass/30断言，Core类型检查通过。
- desktop-build-live-118.txt/package-live-118.txt均exit0，renderer main-Bc1kv_15.js。命令误设CHANNEL而配置实际读取ZAOVRA_CHANNEL，因此产物是Zaovra Dev.exe；首次按Beta文件名启动失败且没有创建进程，确认实际产物后启动新的独立Dev打包实例PID35032/CDP58311/sidecar58345，packaged=true/onboardingTest=true。不是签名发布产物，原112 PID38356仍存活，未重启已有app/server。
- packaged-live-reload-118.txt exit0（8.9s），原115失败用例现两窗口renderer加载后均保留活动文本与queue。真实context在未Ended前已有STREAM_STARTED_108（live-context-118.json）；原任务继续question、回答、完成，再执行队列，总provider调用4次，无并发提前运行。
- 扩展provider第二个闸门：两窗口刷新后才追加_AFTER_RELOAD，并在UI检查完成前禁止发送结束帧。packaged-live-tail-118.txt exit0（7.4s），两窗口在仍流式运行时精确显示STREAM_STARTED_108_AFTER_RELOAD；queue-reloaded-live-tail.png已目视检查，不能由Ended全值覆盖掩盖增量错误。随后完整任务与队列正常完成，再刷新历史不重复。
- live-tail-result-118.json passed/errors=[]；Desktop类型检查通过。115第二次更早admission等待失败在新实例这两次测试均未出现，仍保留原日志，不把它凭空归因于#36。
- 第36项已修复并完成新桌面实例验收。数据库仍memory，账户/模型仍fixture，不作为完整退出恢复或真实API证明；真实签名安装升级与全应用退出恢复等商业门槛仍开放，整体目标active。

### 第一百一十九批：排队消息立即发送闭环

- 上一轮为实质进展。本轮确认最新打包PID35032存活，检查SessionFollowupDock实际“立即发送”入口及session.tsx实现，再扩展--send-now-queue正式探针。
- 原模型流保持活动时先实际发送queue；点击立即发送后确认旧input/:id/cancel成功，新prompt成功且delivery=steer、消息ID与旧admission不同、完整prompt与原内容严格一致。没有仅凭UI消失认为成功。
- 放行原provider结束前严格检查调用仍2次，说明没有并发执行。放行后两个窗口收到追加回复，总provider调用3次；刷新后旧历史/流式文字保持，追加用户消息恰好1条。
- packaged-send-now-119.txt exit0（6.8s），send-now-result-119.json passed/errors=[]，send-now-admission-119.json保留真实请求。未发现新缺陷，无产品变更或重建，未重启已有app/server；probe仅清理自己创建的peer/provider。
- REPORT.md顶部补充当前状态，避免初次审计分级/运行状态被误读为当前状态；历史原始证据仍保留。当前商业门槛未全部完成，memory和账户/模型fixture边界不变，整体目标active。

### 第一百二十批：响应丢失后残留已执行排队项（新增#37，待修复）

- 上一轮为实质进展。本轮确认最新PID35032存活，新增--drop-queue-response。Playwright路由把真实prompt请求送达现有后端并取得200/admittedSeq，再对renderer中止响应（connectionreset）；仅注入客户端网络故障，没有模拟admission结果。
- 原窗口和peer都能看到服务端pending，原窗口刷新后队列仍存在。放行原任务、回答question、当前任务完成、排队任务执行成功，总provider调用4次，追加回复两窗口正常出现。
- 末尾renderer加载后的严格用户文字计数失败2!==1（packaged-drop-queue-120.txt exit1）。独立CDP检查dropped-queue-dom-120.json证明一处是正常user-message-body，另一处是session-followup-dock的立即发送/编辑行，不是模型执行两次，也不是测试把输入框误算。
- 源码session.tsx的queuedFollowups把本地持久followup.items与服务端pending合并。响应丢失后本地mutation失败保留草稿；服务端之后promote移除pending，而本地草稿没有根据已确认消息清理，刷新后形成已完成任务的幽灵队列项。
- #37待修复。需要以真实后端admission/已确认消息消除本地残留，同时保留尚未确认的网络失败草稿，不能简单把乐观消息当确认或无条件清空。随后重复本次故障注入验收，并检查离线期间已promote的恢复情况。
- dropped-queue-response-120.json保存真实200和admittedSeq，dropped-queue-120.png及DOM保存界面。没有新产品改动或重启app/server。第36项仍已修复；#37及整体商用验收继续开放，目标active。

### 第一百二十一批：第37项已确认排队草稿清理（已修复）

- 上一轮为实质进展。修改前followup-confirm-baseline-121.txt导航3通过。新增ServerSession.messageConfirmed，区分真实历史/确认事件与未确认乐观消息；回归断言已加载历史为true、其他会话为false、乐观添加为false、真实message.updated后为true。
- session.tsx新增持久followup状态协调：后端pending已有该ID或messageConfirmed为true时移除本地副本，清理不再对应草稿的失败标记。没有把“暂时未出现在pending”当成成功，也没有无条件删除网络失败草稿；队列展示继续由后端pending负责。
- followup-confirm-unit-121.txt 601pass/1629断言，App类型检查、格式化、diff检查通过。修改后生产构建导航followup-confirm-navigation-after-121.txt 3通过。desktop-build-followup-121.txt/package-followup-121.txt exit0，正确ZAOVRA_CHANNEL=beta，renderer main-r4borwSf.js。
- 新隔离打包PID61680/CDP59269/sidecar59275，launch记录实际独立desktopPath，现有app/server未重启。packaged-drop-fixed-121.txt exit0；真实后端200后中止renderer响应、刷新、当前任务question续行及排队执行，双窗口结果正确，最终文字恰好1处，幽灵队列消失。drop-fixed-result-121.json passed/errors=[]，drop-fixed-admission-121.json保留真实admission证据。
- packaged-send-now-regression-121.txt exit0，send-now-regression-result-121.json passed/errors=[]；取消旧queue、相同prompt新ID提交steer、不并发执行、刷新历史恰好一次全部通过。第37项已修复且桌面红绿验证完成。
- 当前最新产物为package-followup-121/win-unpacked/Zaovra Beta.exe；并非真实签名安装升级验收。memory及账户/模型fixture边界保留，整体商用验收仍开放，目标active。

### 第一百二十二批：请求未到后端时保留失败草稿并稳定重试

- 上一轮为实质进展。本轮确认PID61680存活，扩展--reject-queue-request，在真正发送到后端前abort一次POST，与120/121“后端已200再丢响应”严格分开。
- 等本地失败项重新可操作后renderer加载，FOLLOWUP_PROMPT_111草稿仍留在dock；真实GET input/pending返回空数组（unreceived-pending-122.json），原模型活动期间调用仍2次，证明清理逻辑没有把未确认草稿当作已发送。
- 原任务结束后通过实际立即发送按钮重试，真实请求成功，整个请求对象（含消息ID、prompt、delivery）与被阻断的一次严格相等。两个窗口出现追加回复，总provider调用3次，最终renderer加载后用户消息恰好1条。
- packaged-unreceived-retry-122.txt exit0（6.9s），unreceived-retry-result-122.json passed/errors=[]，unreceived-retry-request-122.json保存重试请求。本批仅增验收探针，无新产品缺陷、修改或重建，未重启任何现有app/server。
- 第37项确认接收与未确认失败两侧行为均有桌面故障注入证据。签名安装升级与整应用退出恢复等商用门槛仍开放，memory和账户/模型fixture边界不变，整体目标active。

### 第一百二十三批：新版独立磁盘实例与完整退出恢复准备

- 上一轮为实质进展。本轮读取实际full-desktop-disk-entry.mjs，使用当前121版生产out、独立appData/XDG目录与显式sessions.db创建新实例PID34576/CDP59635/sidecar59642。不是onboarding memory模式；未重启任何既有进程。
- disk-business-123.txt exit0，disk-business-result-123.json passed/database=disk/errors=[]；提问、多问题回答、第二窗口审批、真实write、撤销恢复与Git审查完整业务通过。主进程入口SHA256保存在launch中，数据库文件非空（WAL模式下主文件4096字节不等于全部数据规模）。
- prepare-process-recovery-123.mjs通过实际UI保存FULL_PROCESS_UNSENT_DRAFT_123，并确认独立.dat中已提交；process-recovery-manifest-123.json记录会话context、窗口ID/tabs、草稿、文件内容、数据库与入口hash，before-process-exit.png记录退出前界面。
- 新增verify-process-recovery-123.mjs，校验启动后PID必须不同、profile相同，在只注入账户fixture的情况下核对历史、草稿、文件、窗口tabs，不重建业务数据或手动导航掩盖恢复失败。仅语法检查通过，尚未执行退出后的验证，不作为完整退出恢复已通过证据。
- 因packages/app-ui/AGENTS.md明确“NEVER try to restart the app, or the server process, EVER.”，已向用户询问是否仅允许该PID/目录的隔离实例退出再启动。尚未收到明确答复，未执行关闭或重启；manifest.restartAuthorized=false。这是仓库指令约束，不是技术失败，也未达到整体blocked条件。
- 当前最新已打包产品仍121；此磁盘实例使用Electron加载生产入口，不能替代签名安装包验收。完整退出恢复与真实签名安装升级继续开放，目标active。

### 第一百二十四批：正式发布产物与签名条件核查

- 上一轮为实质进展，已准备独立磁盘恢复实例。本轮仍无明确重启允许，PID34576确认存活，未执行退出/重启。
- 对当前121 Beta.exe执行Get-AuthenticodeSignature，状态NotSigned；当前用户代码签名证书数量0。仅检查必需环境变量是否配置，不输出任何值：publisher名称、Azure endpoint/account/profile及身份参数均未配置。release-preflight-124.json记录这些布尔状态，不能据此推断GitHub secrets缺失。
- 本机gh不可用；已检查现有GitHub连接能力，其fetch不支持仓库变量/敏感管理端点，因此没有绕过权限读取签名秘密。通过允许的仓库releases GET读取 https://api.github.com/repos/zuozizuozi/p-zaovra/releases?per_page=5 ，连接返回成功且内容[]，未找到正式发布产物供现成安装升级验收。
- 当前配置已包含publisher校验与verifyUpdateCodeSignature，但它们不能让本地未签名产物变成正式签名包。没有修改发布变量、触发CI、上传发布或安装任何文件。
- 整应用退出恢复仍受app-ui/AGENTS.md禁止重启约束，等待第123批针对特定隔离实例的明确允许；正式签名安装升级仍需实际签名配置/产物。两项不能由单测、renderer刷新或未签名包冒充通过。整体目标active，尚未达到blocked审计阈值。

### 第一百二十五批：收尾证据矩阵与录制回放挂起复核

- 上一轮为实质进展。本轮核对初始报告和后续证据，生成ACCEPTANCE-STATUS.md，按全部37项编号归组并明确签名安装、完整退出恢复、原生项目选择、真实账户/供应商与录制回放测试等边界；不把早期未验收项目随着批次数增加自动变成通过。
- 初次审计记载的session-runner-recorded.test.ts未完成项没有找到后续通过证据，因此按当前源码重新运行，RECORD=false，使用已有本地cassette，bun test --timeout 15000。测试长期停在文件标题且持续消耗CPU，没有触发Bun测试超时。
- 通过Win32_Process确认PID59128命令行是本次明确启动的测试，父47164，记录recorded-runner-process-125.json。为结束无界CPU占用显式Stop-Process该测试PID；随后原工具handle87274返回exit1。recorded-runner-review-125.txt保留原始输出。不是因为观察超时推断进程死亡，也没有重启/终止app或sidecar。
- 录制回放挂起原因仍需定位，不能宣称模型执行回归全部通过，暂不列为已确认产品缺陷。该项提供了可继续推进的独立工作，因此即使重启允许和签名条件仍未到位，也尚未处于整体无进展的blocked状态。
- PID34576仍存活，123批恢复准备未被破坏，无产品源码改动或重建。整体目标active。

### 第一百二十六批：录制 HTTP 回放测试初始化修复

- 有界诊断把挂起定位到 runTurnAttempt 的 plugins.wait(PluginInternal.readyID)，尚未进入 HTTP 回放。诊断临时副本与阶段日志保留在 quality；调试器连接尝试失败，未取得调用栈，不将其当作栈证据。
- packages/core/test/session-runner-recorded.test.ts 引入真实 PluginV2 节点，并在空工具录制夹具中登记 PluginInternal.readyID 初始化完成。没有改动产品执行器或绕过其等待逻辑。
- recorded-runner-fixed-126.txt：原始用例 1 pass、0 fail、5断言，总耗时约1.3秒。recorded-runner-types-126.txt：Core类型检查通过。
- 两个临时诊断源码均已移除；桌面入口 SHA256 仍为 17F9C71A66F95F40327EF4EDDADF2B6E76321AFE5ADC4D4ECA618C5FBB49480C，无需重建桌面产物。
- ACCEPTANCE-STATUS.md 已关闭录制测试缺口。完整退出恢复仍待明确允许；真实签名安装升级仍缺签名条件或产物；原生文件夹选择没有实际系统对话框选择证据，当前工具不支持原生应用控制。未重启 app/server，未把账户/模型 fixture 当作正式 API 验收，整体目标未完成。

### 第一百二十七批：剩余门槛复核与受阻状态

- 上一轮完成录制测试修复和证据更新，属于实质进展。本轮核查实际进程和文件：PID34576仍存活，恢复测试文件内容和生产入口hash匹配清单。未收到重启例外答复，未关闭或重启实例。
- 当前121产物签名仍为NotSigned，当前用户代码签名证书数量0；结果保存remaining-gates-127.json。不能据此推断远程签名凭据状态。
- 同一重启指令约束与签名条件缺口已在123–126批持续存在。录制测试缺口关闭后，目前剩余工作需要用户输入或外部状态变化：允许指定隔离实例退出重启、提供实际签名构建条件/产物、完成原生系统文件夹选择操作。账户/模型fixture仅为验证边界，官方API未接入不新增缺陷。
- 当前不声称商业验收完成。停止重复相同检查，目标标记blocked；条件具备后从现有清单和脚本继续，不重做已完成修复。

### 第一百二十八批：完整进程恢复通过，并修复第38项项目打开命令

- 用户明确批准执行剩余任务，解除针对隔离恢复实例的重启限制。relaunch-authorized-128.mjs使用真实IPC app.relaunch；旧PID34576和旧sidecar端口59642结束，新PID65956在同一profile/CDP59635启动，完整命令行核查一致。
- verify-process-recovery-123.mjs exit0。process-recovery-result-123.json passed=true；真实context和tabs与退出前deepEqual，未发送草稿、文件内容恢复。只注入账户fixture并renderer reload一次，没有重建会话、标签或业务数据。不将其声称为正式登录/签名安装冷启动验收。
- 原生工具现可使用@oai/sky；系统截图报SetIsBorderRequired接口不支持，点击报coordinate input geometry unavailable，set_value报UIA CacheRequest属性错误。键盘输入可导航原生对话框，不能把工具错误当作产品缺陷。
- 在旧121产品实际菜单发现Open Project... aria-disabled=true，Ctrl+O无效。源码证明project.open只注册于旧layout.tsx，新layout-new.tsx缺失注册。记为第38项实际功能入口缺陷。
- layout-new.tsx补齐project.open：按当前路由/主页选择确定服务器，禁用无服务器或已知离线情况，通过既有目录选择器处理本地/远程分支，过滤取消/空结果，打开全部选中目录并为首个目录创建草稿，保留服务器身份。
- project-open-baseline-128.txt、project-open-navigation-128.txt均3通过；project-open-types-128.txt类型通过；project-open-unit-128.txt 601pass/1629断言。格式化和diff检查通过。desktop-build-project-open-128.txt、package-project-open-128.txt成功，renderer main-DDUuWgaW.js。
- 最新独立打包PID61956/CDP62197，project-open-launch-128.json，onboarding memory模式。native-menu-fixed-128.mjs断言实际菜单enabled=true并点击，native-menu-enabled-128.json保留证据；原生窗口3219194标题打开项目。
- 通过原生键盘Alt+D、输入路径、Return，系统地址栏真实进入F:\p-zaovra\quality\desktop-audit-20260909\原生选择 128；native-picker-tree-128.txt保存地址栏证据。最终选择确认未完成，已请求用户点击选择文件夹；verify-native-selection-128.mjs准备后续真实草稿、目录、后端文件读取核验，不注入选择结果。
- 已询问实际签名安装包路径或签名配置位置/发布者名称；不请求在聊天中发送私钥或密码，不伪造发布者或签名通过。目标active，签名与原生确认待输入。
- 后续选择校验等待45秒后退出（native-selection-128.txt），没有出现选中目录的项目按钮；用户尚未回复已选择。属于人工确认未完成的验证结果，不声明产品选择失败或全链路通过，原生对话框保留。

### 第一百三十批：恢复执行后的第三轮阻塞复核

- 第128批完成产品修复与完整退出恢复，第129批为已确认实例仍存活的等待。本轮再次通过原生工具确认窗口3219194仍为打开项目对话框，PID61956存活，选择结果文件不存在。
- 最新128产物签名仍为NotSigned，当前用户代码签名证书数量0。remaining-gates-129.json与remaining-gates-130.json保存核查事实。
- 用户批准的重启已执行并验收通过，不再作为阻塞条件。当前阻塞是原生选择确认和真实签名产物/配置，自第128批起连续三轮未满足，且没有收到相应输入。
- 当前没有可独立完成剩余验收的安全动作，标记目标blocked，保留对话框、测试实例和结果；不宣称38项修复等同于正式商用验收全部通过。收到选择确认或签名条件后从现有验证脚本继续。

### 第131批：按用户明确范围交付人工测试开发版

- 用户明确本次需要修复后可用的开发版，后续由其人工测试，不要求现在打包。此前将正式签名安装升级作为本次交付门槛属于范围扩大，现撤销该阻塞；不把旧验收证据改写为发布通过。
- 确认现有启动器.bat及Electron运行程序存在，启动器调用当前源码bun run dev，根目录dev:desktop指向该包。当前README和源码开发账户门控一致：开发桌面可进入工作台，模型使用用户自己的服务配置。
- 按当前工作树重新执行packages/app-ui和packages/desktop-app的bun typecheck，均exit0；未打包、未更改签名或发布配置。
- 新建MANUAL-HANDOFF.md，交付启动入口、已有证据和人工测试顺序。第38项最终原生选择后的验证明确留给人工测试，不标为自动化通过。取消本任务遗留的原生测试选择器，不再要求用户代操作自动化。
- 本次代码修复交付收口，正式发布认证不在当前交付范围。后续人工测试的实际缺陷继续修复，未作无缺陷保证。
