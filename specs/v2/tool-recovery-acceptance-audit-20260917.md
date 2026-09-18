# 工具参数恢复与验收收尾专项检查（2026-09-17）

## 范围与持久待办

用户先要求检查第 1、2 步，随后授权对照 Codex/Cline 修复。下方保留检查发现，实施结果见文末。第 3、4 步仍为待办。本轮修复未重启应用、读取密钥或调用真实模型。HTTP fixture 不访问供应商。真实模型测试必须先申请新 Token 预算。

- [x] 第 1 步检查：参数失败链路代码、竞品对照、离线复现。
- [x] 第 2 步检查：验收登记、最终状态、前端读取路径及离线复现。
- [x] 第 1 步代码与离线回归：OpenAI Chat 兼容协议拒绝调用、保留结束信息与用量、受限模型纠正。真实网关验证待授权。
- [x] 第 2 步代码与离线回归：验收要求合并、套件结果登记、结束前反馈；前端沿用同一 Check/Info 数据合同。真实桌面任务验证待授权。
- [ ] **第 3 步待办**：重复环境探测、重复验收、请求边界预算控制。缓存命中不能代替总消耗管理。
- [ ] **第 4 步待办**：小修改→新小游戏→追加功能的分层实测；在相同交付质量下比较成功率、人工介入、轮次、Token 和费用。真实调用先申请预算。

## 1. 参数失败：已证实宿主问题

路径：`packages/llm/src/protocols/openai-chat.ts:407` → `protocols/utils/tool-stream.ts:finishAll` → `protocols/shared.ts:parseToolInput` → `packages/core/src/session/runner/llm.ts:515`。

OpenAI Chat 在 finish_reason 到达时立即解析所有参数。解析失败发生在新状态返回之前，直接以 LLMError 终止流；结束原因没有作为最终事件交给 Core，后续 usage 帧也无法处理。Core 将其视为整个 Provider 回合失败，结算未完成工具并终止，不能把“尚未执行的参数错误”交还模型纠正。

离线使用真实 LLMClient 和项目 fixedResponse fixture：相同未闭合字符串，分别输入 finish_reason=tool_calls 与 length，后面提供 usage=120。两者均只输出 step-start/tool-input-start/tool-input-delta；同样报 Invalid JSON input，没有 step-finish、用量结算或可执行 tool-call。

这证明宿主混同了两类结束情况、会丢失已提供的尾部用量。**不能反推真实 A/B 的失败一定由输出上限引起**；历史没有完整原始响应，不能补造 finish_reason。本次未发现累计字符串拼接主动截断的代码，也没有原始字节级证据证明网关或模型是哪一方截断。

安全行为必须保留：未闭合参数不可执行，传输中断不能伪装成成功。当前 OpenAI Chat 先解析所有调用，再在 halt 发出可执行事件；修改时必须明确有效/无效混合调用的边界。其他协议可能已执行部分工具，不能把“某个调用未执行”扩展成“整轮未执行”。

### 竞品取舍

- Codex handlers 的 parse_arguments 将解析错误映射为 RespondToModel，与 Fatal 分开。借鉴“反馈模型纠正”，不是盲重放整个请求。
- Cline 的 ai-sdk.tool-calls 测试明确拒绝未闭合字符串。它允许部分完整字符串的括号修复，但本次内容字符串中途停止，不采用自动修补写入。
- OpenCode 的 AI SDK 路径将无法修复的调用转成 invalid 工具反馈；这是特定分支，不代表它所有 runtime 都如此。

### 最小修复建议（待执行）

1. 区分参数无效、输出上限、缺结束帧/传输中断，保留 callID、结束原因、收到的 usage 和参数摘要；不记录正文或 Key。诊断不能只依赖成功的 step-finish。
2. 有合法结束边界但参数无效时拒绝执行，沿现有工具失败记录反馈；继续收取正常尾部 usage 仍受超时和用户取消约束。
3. Core 只对确认未派发的错误调用允许有上限的模型纠正，建议初版最多一次，计入既有轮次限制，不新增隐藏模型循环。不恢复未知副作用，不重跑已完成兄弟调用。
4. 离线覆盖合法长参数、转义/多字节分块、混合调用、length、尾部 usage、EOF、纠正耗尽及取消后，再申请小预算真实验证。

## 2. 验收收尾：已证实的契约缺口

### A：一个套件只能登记一类

`packages/core/src/tool/bash.ts:37` 的 verification 是单一枚举，structured.verification 也是单条 Check；runner 提示却推荐一个脚本完成验收。实际套件登记为 test 后，系统无法得知其他类别覆盖。

离线调用实际 derive：node verify.js、exit=0、目标 game.html，仍为 completed_unverified，缺 syntax/smoke/interaction，与 B 组一致。不能通过匹配“14/14”字样推导覆盖，也不能将 test 自动扩成所有类别通过。

### B：HTML 分支跳过项目必需项

`packages/core/src/session/outcome.ts:86` 使用 html.length ? htmlChecks : requiredChecks。离线明确传入 required=[build,test]，仅 HTML 三类通过时返回 completed_verified、missing=[]。这是确定的规则缺陷：HTML 要求与适用项目要求必须合并，不能二选一。

### C：其他边界与 UI

- HTML 范围来自已登记目标，不是独立交付物清单；新鲜度只核验声明的 targets。只列 HTML 而漏掉依赖 JS/CSS，其变化不会自然使证据失效。先要求明确完整的套件目标，不新增全项目依赖分析器。
- checkKey 使用类别、完整命令、输入 workdir 与目标列表。不同命令拼法不会覆盖旧失败，这是保守保护，不能让任意成功覆盖所有失败。
- session.ts 在查询最终 outcome 时重新检查指纹；runner 只有固定规则和历史记录，没有同等的实时缺项反馈。前端 outcome dock 已显示 missing，但在折叠区域且运行中不展示。不是“完全没有提示”，而是信息和时机不对称。
- Cline 架构以成功 submit_and_exit 标记 task.completed，是流程完成，不代表外部验收全部通过。不能直接照搬完成工具代替工程验证。

### 最小修复建议（待执行）

1. 先合并适用 HTML 与项目必需项，保留失败不可被无关成功掩盖的规则。
2. 沿现有 Bash、Check、Evidence 通路支持一个命令的多项结构化结果，兼容旧单项。优先参考测试运行器逐项报告格式；具体报告方案尚未选定，不把总体 exit=0 复制成各类通过。报告须关联本次执行、命令及目标指纹，失败/跳过/未报告不算成功。
3. 结束边界用同一派生器生成缺项/失败反馈供模型与 UI 使用。状态追加到历史尾部，不放回 system 破坏缓存；相同缺项不无限追加。模型的完成声明不能覆盖系统状态。
4. 离线覆盖套件部分失败、文件变化、遗漏 JS/CSS、HTML+build/test、无关成功、重复报告和续接，再检查前端展示。收尾纠正必须有上限。

## 验证记录

- LLM OpenAI Chat 原有测试 **28/28**；Core outcome 原有测试 **7/7**。这些是现有行为回归，不能当作新问题已修复；旧用例未覆盖 HTML 与 required 同时存在。
- 新诊断调用实际实现，没有复制判定逻辑，没有执行 Shell 或写入工具。
- `quality/chain-audit/0917-parser-inspection.ts`、`.jsonl`：参数错误丢失结束/用量的 fixture 复现。日志出现 request 字样不代表联网。
- `quality/chain-audit/0917-outcome-inspection.ts`、`.json`：套件分类和 HTML 要求覆盖复现。
- `0917-followup-openai-chat.log`、`0917-followup-outcome.log`：原有 35 项测试记录，同目录。

## 参考来源（2026-09-17 检查，分支后续可能变化）

- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/mod.rs
- https://github.com/openai/codex/blob/main/codex-rs/tools/src/function_call_error.rs
- https://github.com/cline/cline/blob/main/sdk/packages/llms/src/providers/ai-sdk.tool-calls.test.ts
- https://github.com/cline/cline/blob/main/sdk/packages/llms/src/providers/ai-sdk.ts
- https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm.ts

本轮是检查结果，不承诺 Token 降幅或自主成功率提升；修复与真实验证状态必须分别报告。

## 授权后实施结果

### 参数失败

复用 LLMEvent.tool-error，增加可选 inputRejected 标记（内部 LLM 事件，不改变公共 Session Protocol）。兼容协议在合法结束边界把坏参数作为未执行的工具错误交给 Core，保留原始 finish_reason 和后续 usage。正常兄弟调用独立结算，不重放。length/content_filter 下即使参数可解析也不执行这些调用。无 finish、网络中断和用户取消仍中止，不假装完成。

Core 将拒绝写入既有 Tool.Failed 历史，最多允许一个自动纠正回合；计数从完整持久历史读取，同一用户请求重建 drain 不会重置。纠正耗尽、内容过滤、未知结束原因不自动继续；用户 Stop 优先。没有调用 jsonrepair，没有拼接缺失代码，没有 DS 模型名分支。此轮兼容协议修复未扩展到其他协议的解析失败路径；其他协议保留原行为并做回归。

### 验收与收尾

- HTML 必需检查与 package.json 中适用 build/test/lint/typecheck 合并，不再二选一。
- Bash 增加可选 verification_report：一次前台命令输出完整 JSON `{ "checks": [{ "kind": "syntax", "status": "passed" }, ...] }`。status 为 passed/failed/skipped；类别唯一，明确提供全部 verification_targets。宿主只解析本次进程输出，不主动读取预存报告文件；这仍不能独立证明脚本没有转述旧结果或确实执行了全部断言。
- 沿原 verification 记录保留套件进程结果，在 verifications 中保留各类结果。真实非零退出不能被报告中的 passed 覆盖；重复类别、空报告、全跳过、截断或错误格式均不认证成功；目标在运行中变化则证据失效。失败报告也进入恢复失败计数，不被进程 exit=0 掩盖。
- skipped 不继承旧通过记录；同命令、目录及目标的整份新套件报告取代旧覆盖，漏报类别也不会继承旧通过。不同命令的失败仍不能由无关成功覆盖。
- 历史工具结果携带全部逐项证据，前端现有 checks 列表和 missing 展示继续使用同一派生结果；无第二套验收状态。
- 模型尝试结束且有已登记但失败/缺失的验收时，宿主用相同 derive 与当前文件指纹生成一次持久化收尾反馈。仅追加历史尾部，不改系统前缀。每个用户请求最多一次收尾反馈，不无限催促；若有未知副作用，不自动进入这一收尾纠正。没有任何验收记录仍为未验证，不因此给普通聊天强加验收循环。

套件结构化报告参考 [Playwright JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter) 的逐项结果思路；这里只是连接现有 Check 的小型适配合同，**不声称兼容任意 Playwright JSON 或复制了其测试框架**。模型编写的脚本与报告依然不是独立 reviewer，不能证明测试覆盖了所有用户需求。遗漏未声明依赖仍是边界，工具描述要求列全 HTML/JS/CSS/脚本，本轮未新增依赖扫描器。

### 离线验证与剩余边界

- Core：171 项通过（7 文件），覆盖真实 Shell 套件报告→模型历史→最终状态、失败/跳过/非零退出/重复类别/目标变化、HTML+项目要求、旧报告漏项失效、收尾反馈最多一次、停止和压缩等既有行为。
- LLM：139 项通过（5 文件），包含 Chat、Responses、Anthropic、工具运行时和诊断；Chat 新用例含长多字节参数、多调用混合失败、length/content_filter、尾部用量与缺终止帧。
- 新跨模块用例：原始 SSE fixture→真实协议解析→Core 持久失败→正常兄弟调用执行→纠正调用→最终停止；兄弟调用只执行一次，原请求用量正确保留。另验证收到拒绝后 Stop 不会启动纠正。
- Core、LLM、App UI、Desktop 类型检查通过；未修改 UI 渲染代码、未生成安装包、未重启当前桌面。当前运行实例不因此自动视为已加载新内核。
- 日志：`quality/chain-audit/0917-final-repair-core.log`、`0917-final-repair-llm.log`，套件独立回归 `0917-final-repair-bash.log`。
- 无真实模型 Token 消耗。修复后的真实自主交付率、Token 降幅、真实供应商异常分类仍未验证，需另申请小额定向测试；第 3、4 步保持待办。

后续更新：另批100万Tokens后，第3步已实施，第4步已做部分真实测试。已上报909290，另一次失败请求用量未知；小模块有指导地完成，新游戏尚未完整交付，追加功能测试未启动。详见 `efficiency-delivery-validation-20260917.md`，不得将离线通过或预算暂停视为完整交付成功。
