# TODO

## Pixel Courier 实测修复（2026-09-18）

- [x] A 首轮真实测试计划：12 次有效重放、4 个正常任务样本、2 个低额度压力样本已跑完。真实参数扩容与继续执行已验证；压力样本独立交付验收均未通过，不代表总体稳定性达标。见 [实测报告](./experiments/output-recovery-live-20260918.md)。

- [x] B 本轮定向修复：原文保留、摘要职责隔离、结构/工具校验、失败保留旧上下文已实现。B1 的 51/51 实施请求保留原文与修正；B2 四份真实摘要重放均通过，含原失败样本。222 项本地测试及 Core 类型检查通过。B2 已报告 83,473 Token，另一次连接失败用量未知。阶段完成，不等于完整基线验收通过。见 [B 实现](./compaction-b-20260918.md)、[B2 实测](./experiments/compaction-b2-live-20260919.md)。
- [ ] B 完整基线遗留：B1 库存压缩前只读阶段执行 `echo probe`，完整验收失败；B2 未重跑整项任务，不改判旧结果。后续需明确只读授权如何由工具权限执行，而非只依赖模型遵守文本，并重新验证完整基线。保留摘要中的取舍/空字符串表述歧义及 head/recent 分割可能诱发重复报告的问题，不以结构校验冒充语义正确。当前无新增实测调用。见 [B1 实测](./experiments/compaction-b1-live-20260918.md) 与 B2 边界。
- [x] C 本轮证据与完成判定修复：历史过程证据、补充说明与任务缺口分开；209 项本地回归通过。第四轮 CSV 全链路通过，库存独立检查通过但运行时被说明关联误拦；最后修复后使用两项未经改写的原始会话与判题前归档回放，均判定通过。阶段收尾，不宣称最后版本已重新跑两次完整实测，也不保证模型的语义分类永远正确。已知累计 6,001,483 Token，另有两次连接失败用量未知；任务自然结束，不再发起调用。B 未推进。见 [第四轮修复与实测](./verification-c4-20260918.md)、[第三轮记录](./verification-c3-20260918.md)。

  2026-09-18 追加实证：正常 CSV 两组独立验收通过但旧验证失败记录保留为 failed；软额度压力组自写 15 项测试通过且被标记 completed_verified，却遗漏单个空字段的 CSV 往返要求。C 已据此实现本地修复；旧记录回放的结果和仍保守保留的复合命令失败，见上述实现记录。

ok we need to work towards a launch of v2 so we can get out of this rebuild phase

## Post-Hono cleanup - Kit

The zaovra server has moved to the Effect HttpApi backend. Remaining work is
mostly cleanup: delete compatibility shims, shrink Zod surfaces, and simplify
test harnesses that used to compare Hono and HttpApi behavior.

## New Data Mode - Dax

This is mostly done. I'm working through modeling subagents, skill invocations
and shell commands.

## Rework agent loop - Kit?

The first Effect-native local runner slice is implemented without bridging
through legacy `SessionPrompt.loop(...)`:

- process-global `SessionExecution.resume(sessionID)` discovers Location from
  the Session read model
- cached Location-scoped `SessionRunner` resolves one supported catalog model
  and issues one explicit `llm.stream(request)` provider turn at a time
- durable V2 projections record text, reasoning, provider failures, tool calls,
  tool results, and assistant output
- a scoped `ToolRegistry` advertises definitions and the first permission-checked
  `read` built-in
- local continuation reloads projected history, and promoting new user input resets the selected agent's configured provider-turn allowance
- concurrent resumes for one Session join one process-local run while different
  Sessions remain concurrent

Prompt admission now uses a durable `session_input` inbox rather than immediate
transcript projection. `steer` inputs promote at the next safe provider-turn
boundary while the current drain requires continuation. `queue` inputs remain in
a FIFO until the Session would otherwise become idle and then promote one at a time.

Next reviewed slices:

- preserve eager structured local-tool settlement: durably record each complete
  call, start its child execution immediately, await every settlement after the
  provider turn closes, then reload projected history once
- revisit per-turn tool-call limits, output truncation, and operational
  backpressure before broadening exposure; eager local execution is deliberately
  unbounded in the current local slice while SQLite publication stays serialized
- remove the public in-memory `@zaovra-ai/llm` tool loop after replacing its
  remaining one-turn native-adapter use with a narrow typed dispatcher
- batch streamed deltas and add covering context indexes
- expose replayable Session event cursors over HTTP and the generated SDK where remote consumers need them
- local Bash now uses BackgroundJob for owner-bound get/wait/cancel, managed logs,
  and durable shell completion events. Remote process ownership, restart adoption,
  and automatic provider continuation on completion remain separate deferred slices;
  do not turn shell completion into a synthetic user prompt.
- add durable/clustered interruption, retries, and stale-owner fencing only as
  their slices become concrete

### Deferred durable continuation recovery

Do not infer that ambiguous provider work is safe to retry from an advisory wake.
The first inbox-driven runner intentionally omits outer provider-attempt markers
until they have a concrete consumer and a complete recovery policy.

Design post-crash continuation recovery as one explicit slice. It should model:

- promoted input and projected-history state
- queued-input promotion and steering assignment
- provider-attempt preparation versus provider-dispatch ambiguity
- required post-tool continuation across process loss
- explicit `retry` and `abandon` decisions for unknown outcomes
- bounded automatic retry only where provider and tool idempotency make it safe
- retry budget, backoff, visible recovery status, startup discovery, and future
  clustered ownership fencing

Do not introduce an enclosing durable execution identity solely to group these
facts; a process-local Session drain has no durable transcript boundary.

## Plugin API design - James?

We need to figure out how we want server plugins to work and what hooks are useful.

Some ideas:

- plugins get immer drafts so bad mutations can be thrown away
- plugins get global "zaovra" instance like in that post i showed
- zaovra instance has stuff like `zaovra.session.prompt()` or
  `zaovra.tool.register({...})`

## Rework Config - ???

We should do another pass on config to clean up any mistakes we made with it and
simplify as much as possible. Old configs should get auto-converted to new

## Auth - ???

I have a basic auth system that can track any kind of auth, not just providers

## Model Database - ???

I have a basic model service that allows for models to be registered dynamically

## Provider - ???

Providers should register as plugins and autoload based on whatever logic they
want / config. They should register models into model database

## Event - Kit

The self-contained durable `EventV2` core service is implemented. It owns
sync-versioned persistence, transactional sequencing, pub/sub, replay, and
replay-owner claims without relying on the old bus system.

Remaining slices:

- expose the embedded consumer-facing Session cursor API over HTTP and the
  generated SDK where remote consumers need it
- keep replay-owner claims distinct from future clustered Session execution
  ownership and stale-runtime fencing

## Deferred hardening cleanup

Keep these visible, but do not block functionality slices on them unless a concrete
failure appears during canary work:

- serialize database migration claiming across processes; current migration
  application is protected only by an in-process semaphore, so two processes
  starting against one SQLite database can still race
- simplify process-local durable-tail wake lifecycle with Effect `RcMap` and one
  shared `PubSub.sliding<void>(1)` per active aggregate; keep SQLite cursor replay
  and subscribe-before-history semantics unchanged
- durable aggregate tails now read pages of 256 events and poll every five seconds
  while idle to observe other SQLite writers; shared per-aggregate polling remains
  a possible optimization if subscriber count justifies it
- stream-cap websearch body collection before parsing
- add ripgrep execution timeout and bounded line framing
- materialize or consistently reject unresolved URL and file attachment sources
- decide stateless OpenAI Responses hosted-tool continuation behavior; reconstructed hosted output can replay as a stored `item_reference` when `store !== false`, while `store: false` intentionally omits the unavailable reference path
- decide whether to preserve deprecated `@zaovra-ai/llm` orchestration exports
- preserve or alias renamed filesystem SDK generated type names if compatibility
  consumers require them
- revisit syscall-level mutation confinement for hostile external processes
  (`openat`, `O_NOFOLLOW`, and descriptor-relative mutation where supported)

## Everything is hotreloadable - ???

Instead of needing to tear down things when something changes every service should emit granular events so services can react to them and reconfigure themselves. Allows frontend to receive these too, eg model.added. also prevents startup from blocking
