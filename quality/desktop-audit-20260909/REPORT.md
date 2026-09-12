# 桌面端商业使用审计

日期：2026-09-09。范围：Windows Electron 主进程、preload/IPC、app-ui、SDK、运行中的 sidecar、相关 Server/Core 会话链路。

> 当前状态（第121批）：本文前部保留初次发现时的行为和分级，不代表修复后的当前运行状态。第36项“运行中刷新丢失流式文字”及第37项“响应丢失后残留已执行排队项”已完成代码修复和新打包桌面实测；排队、取消、编辑重发及立即发送也有真实UI→后端→模型fixture的业务证据。当前最新测试产物为 `package-followup-121/win-unpacked/Zaovra Beta.exe`，不是已签名的商业安装包。整体商用验收仍未完成，尤其是真实签名安装升级与整应用退出恢复；详见文末批次记录及 `REPAIR-PROGRESS.md`。官方API未接入始终不作为独立缺陷。

结论：当前版本不建议直接作为稳定商业版本交付。初次审计发现 11 组问题；修复回归中新增第 12 项，合计 5 组 P1，6 组 P2，1 组 P3。最严重的不是缺少 HTTP 接口，而是 V2 事件和数据已经到达客户端，但 UI 没有正确消费。官方 API 尚未接入不计入问题。本文记录发现时的行为；当前修复与验收状态见 REPAIR-PROGRESS.md。

P1：正常任务可能卡住、关键结果不可见或核心行为错误；P2：特定流程失效或语义不一致；P3：体验和质量门禁问题。本文区分实际运行验证、隔离复现和静态链路证据，不将源码推导冒充完整端到端验证。

## 已确认问题

### 1. P1 — 新权限审批和提问不会进入桌面 UI 状态

- 触发：运行中的 V2 任务请求工具权限或调用提问工具。
- 后端发布 `permission.v2.asked/replied`、`question.v2.asked/replied/rejected`，事件桥保留原名。桌面状态处理器只有旧的 `permission.asked/replied`、`question.asked/replied/rejected` 分支，整个 app-ui 没有 V2 对应分支。
- 影响：新的审批/问题无法正常弹出；后台等待用户，用户看起来像任务卡死。回复事件也不能正确清理其他窗口的状态。初始化列表查询可能在重新同步后补出待处理项，但无法替代正常实时链路。
- 证据：`packages/schema/src/permission.ts:43`、`packages/schema/src/question.ts:70`、`packages/zaovra/src/event-v2-bridge.ts:43`、`packages/app-ui/src/context/server-sdk.tsx:203`、`packages/app-ui/src/context/server-session.ts:1193`、`:1223`。
- 验证：两个隔离测试直接向实际 `createServerSession.apply` 输入 V2 事件，permission/question store 均为 undefined。见 `probes.test.ts:40`、`:49`。
- 修复方向：统一事件适配，权限还必须转换 action/resources/save/source 字段；覆盖 asked/replied/rejected、自动审批和跨窗口清理。验收必须由真实工具触发审批/提问、在 UI 回复后继续执行。

### 2. P1 — 新建窗口覆盖共享权限处理器，旧窗口失去剪贴板和通知权限

- 所有主窗口共享 Electron 默认 session，却各自重设 session 的 permission handlers，闭包只允许最近创建窗口的 webContents ID。
- 实际运行复现：原窗口 clipboard-write 和 Notification.permission 都为 granted；通过桌面菜单新建第二窗口后，原窗口两项变 denied，新窗口仍 granted；关闭测试窗口后，原窗口仍 denied。
- 影响：多窗口下复制、通知等功能失效，关闭新窗口不能恢复旧窗口权限。
- 证据：`packages/desktop-app/src/main/windows.ts:190`、`:206`、`:413`。
- 修复方向：按共享 session 安装一次处理器，动态验证所有仍存活且受信任的 renderer；不要只捕获一个窗口 ID。
- 环境说明：测试窗口已关闭，原窗口未重启。**当前原窗口的这两项权限仍处于 denied 状态**。遵守 app-ui 的禁止重启要求，没有自动重启应用规避问题。

### 3. P1 — 撤销状态在 V2 → UI 转换中丢失

- 后端 Session 有 revert 信息，`adaptSession` 委托的 `toLegacySessionSummary` 没有复制它。
- 影响：撤销后的会话重新加载/重新进入，前端丢失撤销边界，已撤销消息可重新显示，重做入口失去依据；文件状态与聊天展示不一致。这里是前端状态遗漏，不是数据库中的撤销信息被删除。
- 证据：`packages/app-ui/src/context/global-sync/home-session-index.ts:162`、`packages/app-ui/src/context/v2-session-adapter.ts:12`、`packages/app-ui/src/pages/session.tsx:547`。
- 验证：`probes.test.ts:36`，输入含 revert，转换结果为 undefined。
- 验收：编辑文件→撤销→切换会话→重新进入→重做，聊天边界与磁盘内容全程一致。

### 4. P1 — 长任务冷加载会丢掉最新一批助手消息

- 历史加载为寻找父 user 消息最多翻 4 页。默认每页 20；当最近 80 条里没有 user 时停止。适配器只在已知 parentID 时输出 assistant，因此已获取的最新助手消息被丢弃，游标却向旧历史推进。
- 影响：长时间工具循环产生的真实输出在重新打开会话后缺失，甚至呈现空会话；数据仍在服务端，UI 加载链路错误。
- 证据：`packages/app-ui/src/context/server-session.ts:477`、`packages/app-ui/src/context/v2-session-adapter.ts:115`。
- 验证：实际 SDK + 本地 HTTP fixture，1 条 user 后 90 条 assistant，冷加载后最新 `msg_090` 不存在。见 `probes.test.ts:59`。
- 修复方向：找到准确父消息或保留尚未关联的消息，不得在游标推进时丢掉已取回的数据。验收覆盖 100+ provider turn、跨页、压缩记录和再次加载。

### 5. P1 — UI 排队没有使用服务端持久队列，而且可能在任务中途提前发送

- 排队操作只写 workspace 的本地 followup store；发送 effect 只处理当前路由 params.id。切到其他会话/首页或关闭窗口后，原会话排队项没有独立的后台调度，需回到对应页面才可能继续。
- 发送时固定 `delivery: "steer"`。与此同时，状态层收到每个 `session.next.step.ended` 就设 idle；Core 一个 step 结束后仍可能继续 provider loop。这使本地队列有在 provider turn 间隙作为 steer 提前发送的路径，违反“等任务结束”的队列含义。
- 证据：`packages/app-ui/src/pages/session.tsx:606`、`:1758`、`:1807`、`:1970`；`packages/app-ui/src/components/prompt-input/submit.ts:195`；`packages/app-ui/src/context/server-session.ts:905`；`packages/core/src/session/runner/llm.ts:383`、`:457`。
- 验证等级：前端控制流和后端 continuation 语义静态确认；未用真实模型跑切页竞态。独立真实 HTTP 冒烟已确认后端 `delivery: queue, resume: false` 会持久入队，重复同一 ID 不产生第二项，说明服务端能力存在但 UI 没接上。
- 修复方向：按用户选择直接持久 admission，消费服务端 pending inputs；UI busy/idle 应反映整个 drain 的状态，不能用单个 step 结束代替。

### 6. P2 — 排队项重试不复用消息 ID，可重复执行已接收请求

- 排队项已有稳定 ID，但调用 sendFollowupDraft 没有传 messageID；该函数每次生成新的 message ID。
- 当服务端已经接收、客户端却因断连/响应丢失报失败，再点发送会成为全新输入，后端无法按原 ID 去重；可能重复工具操作。
- 证据：`packages/app-ui/src/pages/session.tsx:1758`、`:1809`；`packages/app-ui/src/components/prompt-input/submit.ts:134`。
- 验证等级：静态请求构造链路确认；未注入网络故障制造真实重复任务。后端 exact retry 和 conflicting retry 分别已验证去重与 409。
- 修复方向：一个逻辑输入保留稳定 ID，重试携带完全相同的 prompt 和 delivery；对已 admission 的项目采用查询/协调恢复。验收丢失响应后重试仍只有一条 input 和一次工具效果。

### 7. P2 — 会话改动缓存请求未带项目目录

- ServerSync 用未绑定 directory 的全局 client 创建 ServerSession；`diff(sessionID)` 调用 `/vcs/diff?mode=git`，没有从 sessionID 解析目录，也没有传 directory。
- 影响：session_diff 缓存及依赖它的输入框文件变更提示会读取默认工作目录，可能为空或属于其他项目。桌面主进程会切到用户目录，不能假设默认目录等于打开项目。
- **范围限定**：Review 的 Git/branch 模式另用绑定目录的 sdk client；此项不声称所有 Review 请求都缺目录。
- 证据：`packages/app-ui/src/context/server-sync.tsx:213`、`packages/app-ui/src/context/server-session.ts:1340`、`packages/app-ui/src/components/prompt-input.tsx:192`、`packages/desktop-app/src/main/index.ts:120`。
- 验证：隔离 HTTP 记录 query 中 directory 为 null，见 `probes.test.ts:89`；运行中网络也观察到无 directory 的请求。
- 验收：同时打开两个不同 Git 项目，缓存与输入框提示只反映各自项目。

### 8. P2 — “上一轮变更”仍依赖无人填充的旧字段

- Review 的 turn 模式读取 `lastUserMessage().summary.diffs`；V2 user schema 没有这个字段，消息适配器不生成它，也没有把 assistant snapshot/files 转换成这份 turn diff 数据。
- 影响：UI 仍提供上一轮变更入口，但 V2 历史重载后没有数据来源，真实工具改动无法通过这一路展示。Git/branch 模式是另一条数据链路，不受此结论概括。
- 证据：`packages/app-ui/src/pages/session.tsx:652`、`:703`；`packages/schema/src/session-message.ts:45`、`:173`；`packages/app-ui/src/context/v2-session-adapter.ts:65`；`packages/app-ui/src/context/server-session.ts:905`。
- 验证等级：schema→adapter→UI 数据流静态确认；实际 UI 可见此模式，未做真实模型编辑文件的完整复现。
- 修复方向：以 V2 快照/变更接口实现一轮范围的差异，明确轮次边界；验收刷新前后上一轮变更内容一致。

### 9. P2 — Slash command 只展开文本，忽略 agent/model/subtask

- sendFollowupDraft 查到 command 后仅使用 template；后续 switchAgent/switchModel 仍采用输入框 draft 的选择，完全不消费 command 的 agent/model/subtask。
- 影响：配置指定的 agent、模型及子任务语义不生效；例如内置 review 设置了 subtask=true，却在当前会话直接作为文本提交。不能将命令设定当作有效的执行隔离。
- 证据：`packages/app-ui/src/components/prompt-input/submit.ts:109`、`:181`；`packages/core/src/plugin/command.ts:18`。
- 验证等级：静态发送链路确认。验收带不同 agent/model 和 subtask 的命令，检查实际 Session、模型与父子会话关系。

### 10. P2 — Windows 协议链接冷启动缺少初始 argv 消费

- 主进程只处理 second-instance 的 argv 和 open-url；没有从首次启动的 process.argv 提取 zaovra://。pendingDeepLinks 从空数组开始。
- 影响：Windows 上应用关闭时通过协议链接首次打开，应用可能启动但目标动作丢失；已有实例时的处理路径不能覆盖这个场景。
- 证据：`packages/desktop-app/src/main/index.ts:70`、`:216`、`:229`、`:298`。
- 验证等级：源码路径确认；没有关闭/重启用户现有应用，也未做安装版协议注册测试。验收安装版分别测冷启动和已有实例，链接仅执行一次。

### 11. P3 — 15 种语言缺少 21 个自定义 Provider 发现功能文案

- 现有 app-ui 单元测试因此失败；ar/br/bs/da/de/es/fr/ja/ko/no/pl/ru/th/tr/uk 缺对应键。中文简繁及英文完整。
- 实际语言合并有英文 fallback，因此是混合语言和质量门禁失败，不是必然显示裸 key 或整个功能不可用。
- 证据：`inventory.json` 的 localeMissingKeys；`packages/app-ui/src/context/language.tsx:114`。
- 修复方向：补齐翻译并使现有语言一致性测试通过。此问题属于自定义 Provider UI，不是官方 API 未接入。

### 12. P2 — 子任务返回 ID 与任务卡片导航字段不一致

- V2 TaskTool 输出结构为 `{ task_id, content }`，投影保存为 tool.state.structured；UI 两种任务卡片读取 metadata.sessionId。
- 原 adapter 原样传递 structured，没有将 task_id 转为 sessionId，导致完成的子任务卡片无法得到直接导航地址。
- 证据：`packages/core/src/tool/task.ts` Output、`packages/app-ui/src/context/v2-session-adapter.ts` adaptTool、`packages/session-ui/src/components/message-part.tsx` taskId/childSessionId。
- 回归新增真实 V2 输出形状测试，修复前失败、修复后通过。生产 Chromium 的子任务导航场景也改成返回 task_id，并通过点击导航验证，避免旧 fixture 的 sessionId 掩盖错误。

### 13. V2 配置与桌面旧读取接口不兼容（P1，打包版新复现）

- 使用有效 V2 `providers/commands` 配置，V2 Session 创建及模型选择成功；桌面的 `/provider`、`/agent`、`/config`、`/path` 等旧接口却返回 400 `ConfigInvalidError: Unrecognized keys: providers, commands`。
- 结果是项目无法完整加载、模型列表为空。这不是官方 API 未接入导致的问题，使用本地受控 Provider 同样复现。
- 将配置改回兼容格式后，同一 Location 的旧错误仍被缓存，`/instance/dispose` 本身也返回相同 400；在全新目录使用兼容配置可以正常完成任务。配置错误后的恢复路径也需要修复。
- 证据入口：`packages/zaovra/src/config/parse.ts` 的严格顶层键校验、`packages/core/src/config.ts` 的 V2 配置定义，以及桌面实际网络响应。

### 14. 排队设置被强制改成引导，队列界面无法进入（P1）

- `settings.general.followup()` 和 `setFollowup()` 都把 queue 改写成 steer，设置页未提供已有翻译对应的跟进行为选项。
- 后端已有 durable queue 和输入框队列实现，正常用户却无法开启。现已恢复保存/读取 queue 并在通用设置提供选项；完整打包版交互验收继续进行。

### 15. 空会话和长历史的刷新参数越界，工具卡片实时缺失（P1）

- 首次加载空会话后缓存消息数为 0，强制刷新发送 `limit=0`；累计历史超过 100 条后会发送大于 100 的值。后端约束为 1–100。
- 打包版实际出现多次 `/api/session/.../message?limit=0&order=desc` 返回 400；文字流正常，但已完成问题和子任务卡片直到刷新整个界面才出现。
- 已将服务端分页请求限制在 20–100，并处理 tool.progress 刷新；新增空会话与 120 条缓存的实际 store 回归，两项通过。仍需新打包版复核实时显示。

### 16. 子任务的长 ID 被 HTTP 路由长度限制拒绝（P1）

- 打包版实际命令生成的子会话 ID 超过 100 字符。父任务执行成功，但点击卡片读取子会话返回空 404；同类长消息 ID 的取消路径也受影响。
- 原因是底层路由默认 maxParamLength=100，未覆盖系统自己生成的确定性子任务 ID。
- 三个实际 HTTP 入口统一设置 maxParamLength=1024，保留已有 ID 与重试语义。真实 HTTP 回归覆盖长会话创建/读取、长输入 admission/取消；桌面交互复核见修复进度。

### 17. 服务商停用和模型黑白名单未迁移到执行器（P1）

- 桌面停用服务商写入 disabled_providers；旧配置的 enabled_providers、模型 whitelist/blacklist 也未被 V1→V2 转换保留。新运行环境因此仍可能列出或执行被配置排除的模型。
- 已补 V2 provider_filter、Provider.filter 及 disabled；迁移并应用精确 ID 过滤，deny 优先，空 allow 禁用全部，较高优先级配置可用空 deny 清除原限制。真实 Catalog 回归通过。
- 已打开运行环境的刷新仍受 #19 影响，不能因此宣称桌面停用全链路已完成。

### 18. 项目配置保存到加载器不读取的文件（P1）

- PATCH /config 原来写入项目 config.json，而旧、新项目加载器均读取 zaovra.json/zaovra.jsonc。既有测试只断言写入文件，未验证重新读取，掩盖了返回成功但设置未生效的问题。
- 已改为优先更新已有 zaovra.jsonc，否则更新 zaovra.json；保留 JSONC 注释及未修改字段。实际 HTTP 保存、目录销毁后重读的回归通过。

### 19. 保存配置后已打开的 V2 目录仍使用旧设置（P1，已修复接口路径）

- 实际默认服务器测试先读取 V2 provider 目录，再通过 PATCH /config 停用自定义服务商；即使已收到旧 Instance 销毁事件，V2 provider 目录仍包含该服务商。
- 已在项目及全局配置保存后刷新实际 V2 LocationServiceMap。按目录筛选受影响缓存，全局保存覆盖全部已缓存目录；利用引用计数保留活动任务借用的旧运行环境。原失败证据 config-live-refresh.txt 保留，复现已移入正式 httpapi-config.test.ts 并转绿。
- 活动提问验证：刷新后新 Question 服务能回复旧服务的待处理请求，原等待正常结束。真实目录作用范围及全局刷新验证通过；完整桌面实机结果见修复进度。

### 20. 同目录运行服务被拆成多个实例，状态和终端接口不一致（P1，已修复并实机验证）

- 实际会话写入已产生语言诊断，/lsp 却返回空列表；新 PTY 接口创建默认 PowerShell 成功，旧接口按同一 ID 查询返回 404。
- 两个原因叠加：旧状态/文件/PTY handler 自行提供另一套 LocationServiceMap；缓存键未统一省略 workspaceID 与显式 undefined，造成同目录再次初始化。
- 已统一 handler 继承服务器共享 map，并规范化全部缓存入口的 directory/workspaceID。新增完整 HTTP 会话→工具→诊断→状态回归及缓存键回归；新旧 PTY 跨接口测试加入正式套件。
- Windows 独立桌面包验证 /lsp 返回真实 connected/error，测试语言服务退出后 UI 无刷新自动变红；新旧终端接口可交叉读取/改名/删除，通过旧 WebSocket 向新接口创建的 PowerShell 发送命令并收到真实执行结果。证据见第七十/七十一批进度。

### 21. Windows 发布签名缺失被当作成功，更新渠道配置不一致（P1，部分修复）

- CI 中 Azure 签名参数缺失时 sign-windows.ps1 原先 exit 0，真实 PowerShell 复现两项失败；已改为失败退出，签名前严格验证所有目标文件，签名后检查 Authenticode 状态。缺失/部分配置与无效目标四项回归通过；未验证真实 Azure 签名成功路径。
- Beta 安装包配置发布到 beta，但 updater 固定查询 latest 且关闭预发布；已按构建渠道选择 beta/latest 及 allowPrerelease，Beta 实际构建产物确认 channel=beta。
- 第99批已开启 Windows 更新签名校验，并将 WINDOWS_SIGNING_PUBLISHER_NAME 传入 signtoolOptions.publisherName；发布工作流从同名仓库变量读取。CI 缺少名称时拒绝签名，签名后还要求证书 CN 或完整 Subject 与配置准确匹配。11项配置/真实PowerShell回归及桌面类型检查通过；实际安装的 electron-updater 校验函数对本地未签名下载样本返回拒绝结果。准确证书发布者名称仍未提供，真实签名成功、打包元数据及安装升级尚未验收；本地未配置发布者的未签名开发包不计为启用可信更新校验。

### 22. WSL 停止只终止 Windows 启动进程，Linux 后台可能残留（P1，机制已修复，业务实机链路待验收）

- `wsl/sidecar.ts` 的 listener.stop 直接 child.kill；`wsl/servers.ts` stopAll 不等待 Linux 退出。真实 Ubuntu 中以唯一 argv 标记启动90秒 sleep，杀掉对应 wsl.exe 后该 Linux 进程仍存活，见 wsl-launcher-stop-result.json。探测随后只对匹配唯一标记的测试进程发送 TERM 清理。
- 这会使退出/重新启动 WSL 服务后旧服务可能继续运行；单纯等待 wsl.exe 的 exit 不足以证明后台已清理。没有终止发行版或已有用户后台。
- 独立 stdin 生命周期原型在正常管道关闭与 launcher-crash 两模式均确认测试进程已退出（wsl-stdin-lifecycle-result.json）。此为修复方案验证，尚未接入产品，不能视为产品修复完成。
- 第七十九批已接入产品：lifecycle.ts 管理Linux子进程与stdin监控、六秒宽限后强制清理；sidecar停止返回等待Promise；controller退出等待在途启动及持有后台，失败可重试，旧服务停止失败时禁止替代启动。正式测试直接调用产品机制，在Ubuntu覆盖正常停止、launcher崩溃、忽略TERM及自行退出；桌面类型检查和Beta构建通过。仍未把真实WSL业务服务/工具子进程/打包UI全链路算作验收通过，详见进度记录。
- 第八十批进一步复现并修复detached工具残留，以每次后台唯一环境归属标记清理继承标记的后代。真实Ubuntu六项回归包含脱离工具和两个后台的清理隔离，全部通过；实际WSL业务服务全链路仍待验收。
- 第八十三批实际Linux Server/HTTP/模型/Core Bash链路通过，包含完整写文件任务，以及确认Bash命令正在执行时停止后台、核验该命令消失和端口关闭。见wsl-business-result.json和wsl-business-active-tool-result.json；WSL安装、解析、桌面UI入口仍未用该证据冒充验收通过。

### 23. 重新启动在后台清理失败时仍强制退出（P2，已修复控制逻辑）

- index.ts 原来在 stopSidecars().finally 中无条件 app.relaunch/app.exit，且不合并重复请求；不能沿用普通before-quit链路已通过的结论。
- 新增relaunch控制器，只有清理成功才重启；失败恢复quitting状态并允许重试，并发请求共享一次清理。正式回归覆盖等待、并发、失败不重启和重试。没有在用户运行实例上执行重启。

### 24. WSL 状态变化重建应用，缺失连接回退到错误服务（P1，已修复选择逻辑，实机恢复体验待验收）

- Desktop App原以实时availableStartupServer结果作为keyed Show的键，WSL晚就绪或失败会重建整个AppInterface，覆盖用户当前服务选择和页面生命周期。
- ServerProvider.current在选中key不存在时回退到服务器列表首项，造成key/scope仍为WSL而HTTP目标变成Windows；正式回归修复前明确返回本地sidecar（server-identity-before.txt）。SDK/Sync对显式路由目标也有相同nullish回退。
- 现启动选择仅在初始化完成后确定一次；连接查询只匹配明确key；缺失当前连接由ConnectionGate阻止业务子树并显示连接错误。SDK/Sync的显式目标不可用时不再读取当前服务。局部与全套单元/类型检查通过；指定路由在断线/恢复时的实机交互仍待验证，不能仅据选择函数测试宣称该体验闭环。

### 25. 暂时不可用的服务会导致会话和草稿标签被删除（P1，已修复并通过浏览器回归）

- TabsProvider按实时server.list过滤打开标签和最近关闭记录。WSL启动/断线期间不在ready连接列表，标签便被丢弃；草稿路由找不到draft后自动返回首页。
- 新增缺失目标服务浏览器回归，会话场景通过而草稿场景失败且落到首页（server-route-recovery-browser.txt）。删除可用性驱动的清理后两项均通过；用户明确移除服务仍走既有tabs.removeServer清理。
- 会话/草稿路由另加连接存在性检查，缺失时显示可恢复状态和首页入口，避免构造无目标SDK导致全局致命错误。三项生产导航基准修改前后均无空白/未知采样。服务重新出现在实际桌面后的完整任务恢复仍待进一步验证。

### 26. 服务消失时会话清理重入，旧页面残留并无法正常恢复（P1，已修复并通过动态浏览器回归）

- 复现：在已打开会话输入未发送文字后，从 AppInterface 提供的服务列表移除该连接。草稿正常进入不可用状态，但会话触发 Solid 清理异常，旧输入框仍显示。证据：dynamic-server-recovery-console.txt / dynamic-server-recovery-stack.txt。
- 根因：DirectoryDataProvider 的 onCleanup 再次读取 serverSync()，在服务上下文失效且页面正在销毁时触发计算和重复销毁；同时清理本应绑定原始服务。
- 修复：创建 pin 时保存所属 session 对象，清理直接 unpin 原对象。没有修改 Solid 运行库；定位用的临时清理诊断转换已移除。
- 验证：真实生产 UI 的隔离构建中，会话/草稿各两次离线→恢复均保留路由、标签与未发送文字，无 pageerror；动态测试2项、普通导航及不可用入口5项通过。此为服务列表状态转换验证，不能替代完整 Electron/WSL 或真实网络故障闭环。

### 27. 更新服务凭据后业务请求仍使用旧连接上下文（P1，已修复并通过请求回归）

- 编辑远程服务时，相同 URL 会通过 server.add 更新连接，但 GlobalProvider 原来只按服务 key 查缓存，直接复用旧 SDK、事件流和同步上下文。连接检查使用新密码成功，并不意味着后续业务请求更新。
- 生产 UI 隔离构建中变更同一服务的凭据，再切换会话，实际会话请求仍缺少新认证头；server-credentials-request-before.txt 记录两个使用旧认证信息的请求。最初只等待 message 端点的用例因该页面已有缓存而超时，后改为直接观察目标会话的业务请求。
- 修复：缓存保存 HTTP 配置快照，地址/用户名/密码改变时替换 SDK 与同步上下文并清理旧上下文；保留旧连接对象的调用方以当前服务列表中的配置为准，避免回退到旧凭据。仅显示名称变化不触发重建。
- server-credentials-final.txt 三项通过：目标会话请求带新认证头、无 pageerror，且会话/草稿各两次断连恢复仍保持内容。测试凭据是固定本地 fixture 值，不涉及官方 API；完整编辑对话框与真实远程认证服务器闭环仍需验收。
- 后续第90–91批已补齐实际设置编辑、保存值回显、取消和浏览器存储恢复：server-credentials-persistence-settled.txt通过，新页面读取原保存的凭据发出认证请求，再通过表单清空密码后打开另一页面，业务请求不再携带认证头。页面使用同一浏览器上下文的真实localStorage，未重复运行种子脚本；这不等同于Electron进程重启或已打开窗口实时同步。

### 28. 设置中的浮层菜单被隐藏，子弹窗与底层弹窗争抢焦点（P1，已修复并通过真实编辑交互）

- 在设置→服务→更多选项中，菜单可见但其 portal 外层被父弹窗标记 aria-hidden=true，角色查询无法访问编辑项。server-settings-edit-diagnostic.txt 保存完整祖先属性证据。
- 打开编辑服务子弹窗后，底层设置仍为 modal，点击或聚焦用户名输入框时焦点返回底层 Servers 标签；直接填入凭据时文字甚至落入服务地址。server-input-focus-dom.txt 保存聚焦前后及表单 DOM，server-edit-click-focus.txt 记录真实点击后的焦点断言失败。
- 修复：DialogProvider 仅让栈顶弹窗具有模态焦点管理；MenuV2 的菜单、子菜单和上下文菜单使用组件库支持的顶层浮层标记，使父弹窗不会隐藏它们。没有修改第三方依赖。
- server-settings-settled.txt 完整生产 UI 流程通过：角色定位菜单→点击编辑→用户名焦点/值正确→输入密码→保存→关闭父设置→草稿文字保留→目标会话请求使用新认证头，无 pageerror。用例使用实际控制器和本地 API 响应 fixture，未人工改写产品状态；子弹窗退出按既有100ms过渡等待150ms，不把提前按Escape时的关闭锁当新缺陷。

### 29. 服务配置变更不会更新已打开的其他窗口（P1，已修复并通过浏览器及Electron验证）

- 实际设置流程中，一个页面清除密码后，新页面读取正确的新配置，但之前已打开的页面仍回显旧密码。server-window-sync-before.txt明确记录预期空值、实际为旧fixture密码。
- persisted原来只读取初始存储，没有跨窗口更新通知。新增显式sync选项，仅在服务全局配置启用；以存储命名空间和key隔离BroadcastChannel，在存储写入完成后通知其他窗口。接收更新等待初始异步读取结束；组件销毁后停止应用消息，已开始的保存完成通知后再关闭通道。窗口标签/草稿没有启用共享同步。
- server-window-sync-after.txt六项通过，包括真实设置跨页面凭据清除、恢复、导航及缺失服务入口。App UI单元593项、App UI/Desktop类型检查和Beta构建通过。
- native-persistence-sync-da4d1121/persistence-result.json：两个独立隐藏Electron渲染窗口使用实际产品persisted、PlatformProvider及主进程getStore，通过异步IPC适配验证双向更新、最终磁盘值和窗口私有数据隔离，专用进程exit0。此为原生持久层集成证据，不是完整业务应用多窗口并发任务验收。
- 第93批补测：native-persistence-race-26d0af6e验证截留旧初始值b、先收到更新a、再放行旧值，最终仍为a。另发现第92批实现会在组件销毁时关闭通道，丢弃尚未完成的保存通知；修复后native-persistence-close-fixed-b5f8f532验证保存已落盘、组件已卸载、IPC回复后其他窗口仍收到最终值且无未处理拒绝。整渲染进程退出/崩溃场景尚未由该组件卸载测试证明。
- 第94批补齐进程边界：普通窗口关闭通过，但独立测试renderer强制崩溃时，旧方案已落盘而对端收不到更新（native-persistence-crash-before-8d01bfd1）。桌面改为主进程writeStore提交后直接向可信renderer发送store-write事件，实际preload、Platform订阅和persisted接收链路接通；浏览器及旧preload仍可使用BroadcastChannel。native-store-production-9d0ce3a1使用产品preload及实际writeStore/getStore，明确记录独立rendererPID崩溃、源窗口销毁、对端仍为提交值，主测试进程exit0。

## 已通过的检查（首次审计时；最新修复验证见 REPAIR-PROGRESS.md）

| 检查 | 结果 |
| --- | --- |
| desktop-app / app-ui / server 的 bun typecheck | 三个包通过 |
| desktop-app 单测 | 74 pass，0 fail |
| app-ui test:unit | 575 pass，1 fail（语言键一致性） |
| app-ui test:browser | 30 pass，0 fail；这是 HappyDOM 测试，不能等同真实浏览器 E2E |
| Core coordinator + PTY protocol/ticket | 25 pass |
| Core permission/question/command | 15 pass |
| Core session-prompt/create/history | 53 pass |
| Core session-runner-model | 13 pass |
| desktop package:check | 通过，检查打包输入及嵌入 server chunk；不等于生产安装包验收 |

上述已完成的既有测试合计 785 pass / 1 fail。另新增 5 个针对实际实现的缺陷复现测试，目前 **0 pass / 5 fail，预期暴露本报告问题，并未修复实现**，不要混入原有测试失败数。

实际运行的 sidecar HTTP 冒烟：创建、改名、queue admission、相同 ID 重试去重、冲突 ID 返回 409、shell 执行及历史持久化、归档、取消归档、删除、删除后 404 均符合预期。采用专用临时会话，shell 仅 echo 标记；该会话已删除，没有向模型发起生成。见 `live-smoke-output.json`。已有会话的消息、pending inputs、上下文、todo、权限和问题读取也返回 200，见 `live-session-reads.json`。

接口盘点：运行中 OpenAPI 的 162 个 method/path 与生成 SDK 提取的 162 个 method/path 匹配；preload 的 63 个 IPC 调用均能找到源码 handler。**未发现这两个盘点范围内简单的“调用了不存在的路由/IPC”**。匹配只证明路由存在，不能证明事件名、参数、返回数据和业务语义一致；本次已发现的问题恰在后一层。

## 检查边界与环境记录

- 实际连接现有 Windows Electron dev 实例，使用 DOM、交互、网络和 renderer API 检查；操作设置、自定义 Provider 对话框、Review 和新窗口。截图操作超时，没有完成像素级视觉验收，也没有声称 UI 全面视觉通过。
- 没有执行生产完整打包、安装、签名、自动更新、卸载、macOS/Linux/WSL 全路径和崩溃恢复测试。这些是尚未覆盖项，不列作已确认 bug。
- Core 含 recorded runner 的一组测试长时间不结束，终止的是本次启动的测试进程。随后拆分的上述核心测试通过，但不能宣称完整 provider runner 集成套件通过。
- 运行实例的 preload 和热更新 renderer 存在版本不同步迹象；未把只存在于旧运行实例的接口缺失当作当前源码缺陷。没有重启 app/server。
- 未修改业务源码、SDK generated 文件或用户原有改动；只新增本目录审计材料。没有重建网站，网站未被本次审计修改。
- 多窗口权限复现留下的原窗口 denied 状态见问题 2；其他临时测试窗口和会话已清理。

## 建议修复顺序与交付门槛

1. 先修 V2 审批/提问事件、共享窗口权限，再修撤销与长历史，这四项都有直接复现证据。
2. 将队列接入持久 admission，统一 drain 状态和重试 ID，然后补上 turn diff、目录作用域及命令执行语义。
3. 修冷启动链接和翻译门禁，再做生产安装包验证。
4. 发布前必须用真实可用模型完成一条完整任务：打开项目→发起任务→工具编辑→权限审批→问题回复→中途 steer/queue→切换会话→中断/恢复→完成→检查改动→撤销/重做→重新打开历史。另加双窗口、断线重试、100+ turn、应用重启后的状态恢复。

复现测试从包目录运行：

```powershell
Set-Location F:\p-zaovra\packages\app-ui
bun test --conditions=browser ../../quality/desktop-audit-20260909/probes.test.ts
```

接口和翻译清单可从仓库目录运行 `bun run quality/desktop-audit-20260909/inventory.ts` 重算；其中 live-routes.json 是此次运行实例的快照，服务器更新后需重新获取。

### 补充验证：完整桌面页面组合恢复（第95批）

真实Electron生产产物、独立磁盘profile和真实本地后端完成会话请求后，验证项目、窗口标签、历史消息以及实际输入的未发送文字在两次renderer重新加载后恢复；无pageerror。证据：full-desktop-combined-4d97f0f2/combined-result.json、combined-recovered.png，正式探针full-desktop-combined-recovery.mjs。账户与模型响应使用本地fixture，窗口/项目恢复状态由测试明确播种，主进程和sidecar没有退出。此结果不替代真实账户认证、UI创建项目全过程或整个应用退出后的组合恢复验收。

### 30. P2 — Git 子目录项目的新增文本被显示为二进制文件

- 实机证据：第96批在仓库子目录中运行真实桌面任务，write工具生成recovered-task.txt，完成并撤销/恢复后磁盘内容正常；Git审查却显示“二进制文件”。修复前截图：full-desktop-combined-4d97f0f2/combined-review-settled.png。
- 根因：Git.status/diff返回仓库根目录相对路径，Vcs.diff的文件统计与逐文件patch使用ctx.directory再次解析该路径。打开子目录时路径前缀被重复拼接，新增文本得到0行及空patch；diffRaw的未跟踪文件也受影响。批量tracked patch与子目录范围过滤本身无需扩大。
- 修复：Vcs保留ctx.directory用于列举/批量查询，以ctx.worktree解析返回的仓库相对路径；Git/branch详情与diffRaw采用相同基准。未改变Protocol/HttpApi结构，不需生成SDK。
- 新增真实Git/Effect回归先失败，vcs-nested-before.txt：新增文本预期1行、实际0和空patch。修复后Git/VCS共22pass/51断言，验证子目录新增与修改的hunk、raw输出，以及排除目录外改动；Zaovra类型检查通过。
- Beta构建desktop-build-vcs-nested.txt exit0。新独立真实Electron实例PID51752/CDP64371，profile full-desktop-vcs-7ad8aa92；完整恢复→UI发送→真实审批→写文件→撤销→renderer加载→恢复→审查文本用例通过（full-desktop-vcs-workflow.txt exit0，combined-workflow-result.json passed，combined-workflow.png显示新增文本行）。账户/模型响应为fixture，后端、工具、文件、IPC和UI均为产品实现。现有应用和服务器未重启。

### 31. P2 — 子目录项目审查图片的文件读取路径错误

- 第97批实机在Git子目录新增可解码的PNG，审查显示“加载图片失败”（nested-media-before.png）。正式nested-review-media.mjs先用Image.decode验证fixture有效，再检查实际审查图像；旧实例失败，读取路径是仓库根相对路径，而directory已是项目子目录（full-desktop-vcs-7ad8aa92/nested-media-requests.json）。
- 新增resolveReviewFilePath，在审查边界将工作树相对路径还原为绝对路径，保留绝对路径/文件名字符。V2及旧审查媒体读取接入；旧审查打开文件入口也使用相同转换。后端目录及真实路径校验未放宽。
- 路径修复后真实/file/content已返回200、binary/base64/image/png，但图片仍加载中；诊断一秒5次/file/content、无其他请求。该修复过程暴露加载effect收集读取回调的隐式响应式依赖，进一步将FileMedia加载限定为on(request, ...)；没有把此中间状态视为完成，也不另列独立历史缺陷。
- 最终真实桌面nested-media-final.txt exit0；full-desktop-media-e9493ab1/nested-media-result.json passed，decodedWidth=1，PNG请求严格1次、pageerrors=[]。后续一秒采样无追加请求，截图nested-media.png可见已解码像素。PNG小图是功能fixture，不用于评价视觉设计。
- App单元595pass/1616断言、Session UI单元76pass/180断言，App/Desktop/Session UI类型检查通过；导航生产基准前后3项均通过，blank/unknown=0。最终Beta构建desktop-build-media-lifecycle.txt exit0，renderer main-DxGvpbpQ.js。本轮未重启主进程或后台，仅独立QA实例renderer重新加载。

### 补充验证：双窗口业务与媒体迟到响应（第98批）

- 第1/3项：独立真实桌面双窗口同时收到工具审批，在第二窗口批准后两边清除审批并显示结果；原窗口撤销/恢复后第二窗口同步回滚/恢复，磁盘文件一致、工具只调用一次。full-desktop-multiwindow-final.txt及full-desktop-media-e9493ab1/combined-multiwindow-result.json通过。账户/模型为fixture，业务执行、IPC、窗口和数据均为产品实现。
- 第31项：图片/文本连续切换及图片回复迟到通过，旧图片不覆盖已切换文本；nested-media-switching.txt、nested-media-result.json记录证据。当前包输入检查通过，不替代签名、安装和完整升级验证。

### 补充验证：更新签名配置实际入包（第100批）

- 第21项：独立Windows x64 NSIS测试包构建通过，实际app-update.yml包含Beta渠道和测试publisherName；beta.yml的文件名、大小及SHA-512与安装包一致。证据package-publisher-nsis-local-100.txt和package-publisher-result.txt。使用项目本地同版本Electron，初轮远程下载超时单独保留；该产物未签名、未安装、未发布，不代表真实证书或升级验收完成。

### 补充验证：打包可执行文件业务闭环（第101批）

- 实际win-unpacked/Zaovra Beta.exe确认packaged=true，真实sidecar启动成功；历史/输入renderer恢复、工具审批与写入、撤销恢复、Git文本审查通过，无pageerror。证据packaged-workflow-final-101.txt与packaged-workflow-101/combined-workflow-result.json。账户与模型为fixture、数据库为隔离内存测试模式，未安装，不能据此声称真实账户、磁盘退出恢复或签名升级通过。

### 补充验证：打包实例提问恢复（第102批）

- 第1项问题交互进一步通过真实question工具→UI选项→提交→后续模型请求包含回答→write审批/执行闭环；问题等待期间renderer重新加载后仍能回答。packaged-question-reload-102.txt和packaged-question-result-102.json通过，无pageerror，write仅一次。内存数据库与fixture边界同第101批，不代替整进程恢复。

### 补充验证：多题答案顺序与完整性（第103批）

- 第1项：打包实例两题（单选、多选）UI提交的实际HTTP answers数组顺序及内容完全正确，后续模型请求收到两题对应答案；继续工具执行、撤销恢复通过。packaged-multi-question-final-103.txt和packaged-multi-question-result-103.json记录证据，无pageerror。测试环境边界沿用第101批。

### 32. 拒绝工具审批后回复未结束，界面持续忙碌（P1，已修复并通过打包双窗口复测）

- 实际打包双窗口中拒绝write后文件未创建，但原窗口持续Stop/思考中。实际context显示工具已失败，assistant仍无完成时间和finish；packaged-denial-state-104.json及packaged-denial-buttons-104.json记录证据。
- runner的用户拒绝分支在结束工具后提前中断，遗漏消息结束投影。现中断前调用既有settleInterruptedTurn持久化interrupted结束状态，保留拒绝不继续模型循环的语义。88项runner回归及Core类型检查通过。
- 新打包隔离实例双窗口拒绝通过：审批消失、两边恢复Send、刷新后失败记录保留、目标文件不存在、无后续模型调用。证据packaged-denial-fixed-104.txt及packaged-denial-fixed-104/combined-multiwindow-result.json。旧第100批安装产物不含本修复；本次不是签名/安装/整进程恢复验收。

### 补充验证：拒绝后继续任务与正常路径（第105批）

- 第32项：拒绝并刷新后，在同一Session发送新任务，两窗口收到新回复，旧文件操作没有重做。packaged-denial-followup-105.txt和packaged-denial-followup-result-105.json通过。
- 新版产物的多问题/多选、另一窗口允许审批、写文件、撤销恢复和审查组合回归也通过（packaged-allow-regression-105.txt）。测试边界同第104批，未替代完整发布验收。

### 33. 跳过提问后等待请求不返回，界面停留忙碌（P1，已修复，见第107批验收）

- 新版打包双窗口中，提问期间原renderer重新加载，再由第二窗口“忽略”问题，原窗口持续思考中/Stop。真实context已interrupted/completed且active为空，因此不是第32项完成状态缺失。证据question-reject-state-106.json、question-reject-ui-106.txt。
- question-reject-network-106.json记录结束前发起的wait请求在30秒观察内无响应或失败事件，阻塞前端后续active核对；重复正式用例packaged-question-reject-network-106.txt失败。服务端传播执行中断到HTTP等待者的处理需进一步回归验证，尚未修复，不宣称根因已完全确定。

### 第33项修复与验收更新（第107批）

- 根因确认为coordinator.wait继承执行所有者的中断。观察等待现接收Exit值，将执行纯中断视为结束，保留自身取消及其他错误传播；run/exclusive行为不变。108项协调器/runner回归、Core类型检查通过。
- 新版实际打包双窗口跳过提问通过：wait返回204，active核对成功，两窗口恢复空闲；刷新后同Session可以继续新任务，目标文件未创建。证据packaged-question-fixed-107.txt及packaged-question-fixed-107/combined-multiwindow-result.json/combined-execution-requests.json。第33项状态更新为已修复并通过打包复测；完整发布验收边界不变。

### 34. 新流式回复覆盖上一条历史回复的界面文本（P1，已修复，见第109批验收）

- 同一Session第二次模型流式输出期间，上一条历史回复也显示成了新内容，两处均可见。packaged-question-fixed-107/stream-started.png与stream-nodes.json记录两个不同session-turn的证据；packaged-stop-stream-diagnostic-108.txt严格定位失败。
- 当前V2适配保留会重复的流式text-0 ID，界面增量缓存按part ID索引，跨消息冲突待回归修复。不能用结束后重新拉取历史可能恢复来掩盖流式期间错误。用户Stop验收尚未完成，未将本次测试误算通过。

### 第34项修复与Stop验收更新（第109批）

- V2界面片段ID现按消息隔离，历史转换和实时事件一致，原始tool callID保持不变。新增重复text-0隔离回归；596项App单元、App/Desktop类型检查通过。生产三导航前后blank/unknown均0。
- 新版打包双窗口流式输出时旧回复保持原文、新回复只出现一次；原窗口Stop后provider连接关闭、两窗口空闲、刷新保留部分回复、同Session新任务成功。packaged-stream-final-109.txt及packaged-stream-fixed-109/combined-multiwindow-result.json/stream-started.png提供证据。第34项状态更新为已修复并通过实际UI验收，发布验收边界不变。

### 第34项补充回归（第110批）

- 两消息重复推理/工具ID时界面片段唯一，原始工具callID不变；597项App测试及类型检查通过。新版打包双窗口多问题、审批写入、撤销恢复和Git审查组合回归通过，见packaged-scoped-parts-regression-110.txt与scoped-parts-business-result-110.json。无新增缺陷，发布验收边界不变。

### 运行中追加指令补充验收（第111批）

- 新版打包双窗口中，流式输出未结束时UI发送追加指令，真实admission为delivery=steer/200；当前模型结束前没有并发provider调用，结束后追加指令仅执行一次。刷新后历史及追加内容正确保留。packaged-followup-final-111.txt、followup-admission-111.json、followup-business-result-111.json通过。此证据不替代显式queue语义或整进程恢复验收。

### 35. 设置选择框浮层被父弹窗隐藏于可访问性树（P2，已修复）

- 实际跟进消息设置下拉框expanded，但“排队/引导”选项祖先aria-hidden=true，正常角色定位失败。queue-settings-dom-112.json记录证据。
- SelectV2浮层补上Kobalte识别的data-kb-top-layer，与已有MenuV2一致。UI类型检查、前后三导航与新版实际设置选择均通过。产品仅一行属性修改。
- 同次实际打包队列业务验收通过：delivery=queue，原任务仍需提问/继续时排队指令不执行，原任务完成后只执行一次，两窗口一致、刷新历史正确。packaged-queue-fixed-112.txt及packaged-queue-fixed-112/combined-multiwindow-result.json/followup-admission.json为证据，完整发布验收边界不变。

### 排队消息取消补充验收（第113批）

- 实际UI通过编辑取回排队消息，真实取消接口成功，清空输入后两窗口排队条目消失。当前任务完成时旧队列没有执行，刷新后也未恢复。packaged-queue-cancel-113.txt和queue-cancel-result-113.json通过，无新增缺陷；发布验收边界不变。

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
