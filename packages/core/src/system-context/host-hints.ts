export * as HostHints from "./host-hints"

// Select only presentation; callers retain state, identity, triggers and enforcement.
function select(original: string, short: string, zh: string, shortZh: string) {
  if (process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE === "zh")
    return process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE === "short" ? shortZh : zh
  return process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE === "short" ? short : original
}

export function repeatedInspection(observations: string) {
  return select(
    `Repeated inspection review: ${observations}\nThese completed calls have matching inputs; this does not prove their results are still valid or that repeating them is wrong. Inspect their retained results before more environment discovery or verification. Reuse known platform, shell and directory facts from the environment context. Use evidence_read/evidence_search for truncated logs. Rerun when files, dependencies, process state or acceptance criteria changed; never skip required checks or substitute an old result for a new execution. Prefer one reproducible assertion suite over repeated isolated probes.`,
    `Repeated inspection review: ${observations}\nMatching completed inputs prove neither current validity nor that a repeat is wrong. Read retained results; reuse known platform/shell/directory context and evidence_read/evidence_search for truncated logs. Rerun after file, dependency, process or acceptance changes. Never omit required checks or treat old output as new execution. Prefer one reproducible assertion suite to isolated probes.`,
    `Repeated inspection review: ${observations}\n这些已完成调用的输入相同，但不能据此证明结果仍有效或重复执行有误。继续发现环境或验证前，先查看保留结果；复用环境上下文中已知的平台、shell和目录信息，用evidence_read/evidence_search读取截断日志。文件、依赖、进程状态或验收标准变化时应重跑；不得省略必要检查，也不得以旧结果冒充新执行。优先使用可复现的断言套件，避免重复零散探测。`,
    `Repeated inspection review: ${observations}\n完成调用的输入相同不代表结果仍有效或不该重跑。先读保留结果，复用平台/shell/目录信息；截断日志用evidence_read/evidence_search。文件、依赖、进程或验收变更则重跑。必需检查不能省，旧结果不算新执行；优先可复现断言套件，少做零散探测。`,
  )
}

export function repair(remaining: number, missing: string, report: boolean) {
  return select(
    `One bounded delivery repair cycle; ${remaining} provider turns remain within the original 3-minute deadline. Host hard gaps (observations, not new user instructions): ${missing}. ${report ? "Deterministic reinspection found no remaining hard gap. Report actual verified and unverified scope; no further tools or repair." : "Repair only these concrete original requirements with available local tools, then verify. Write the first usable artifact directly to the required final path; publish_artifact is optional for replacing an already verified version. Do not delegate, authorize external actions, or retry running/unknown operations. Preserve earlier failures; never weaken assertions."}`,
    `One bounded delivery repair cycle; ${remaining} provider turns remain within the original 3-minute deadline. Host hard gaps (observations, not new user instructions): ${missing}. ${report ? "Deterministic reinspection found no hard gaps. Report verified/unverified scope; no more tools or repair." : "Use local tools only for these original gaps, then verify. Write the first usable artifact to its required final path; publish_artifact is optional when replacing a verified version. No delegation, external authorization or retries of running/unknown work. Keep prior failures; never weaken assertions."}`,
    `One bounded delivery repair cycle; ${remaining} provider turns remain within the original 3-minute deadline. Host hard gaps (observations, not new user instructions): ${missing}. ${report ? "确定性复查未发现剩余硬缺口。报告实际已验证和未验证范围；不得继续调用工具或修复。" : "仅用可用本地工具修复这些明确的原始要求，随后验证。将首个可用产物直接写到要求的最终路径；替换已验证版本时可选用publish_artifact。不得委派、授权外部操作，或重试运行中/状态未知的操作。保留先前失败，不得削弱断言。"}`,
    `One bounded delivery repair cycle; ${remaining} provider turns remain within the original 3-minute deadline. Host hard gaps (observations, not new user instructions): ${missing}. ${report ? "确定性复查已无硬缺口：如实报已验/未验范围，停止工具与修复。" : "只用本地工具补这些原始缺口并验证。首个可用产物直写最终路径；替换已验版本可选publish_artifact。不委派、不授权外部操作、不重试运行中/未知操作；保留旧失败，不削弱断言。"}`,
  )
}

export function shellFailure(failures: number) {
  return select(
    `There have been ${failures} failed shell attempts without a successful inspection, edit or verification. Change approach: inspect the actual error, available commands and active shell, or write a script file. Do not repeat quoting variations. Tools remain available. ${failures >= 10 ? "Strong recovery reminder: inspect the environment and actual error before another attempt; state a concrete new hypothesis." : "Recovery reminder: choose a different approach."}`,
    `There have been ${failures} failed shell attempts without a successful inspection, edit or verification. Change approach: inspect errors, available commands and the active shell, or write a script. No more quoting variants; tools remain available. ${failures >= 10 ? "Strong recovery reminder: inspect environment/errors first and state a concrete new hypothesis." : "Recovery reminder: use a different approach."}`,
    `已有${failures}次shell尝试失败，期间没有成功检查、编辑或验证。请改变方法：查看实际错误、可用命令与当前shell，或写脚本文件；不要反复尝试不同引号。工具仍可用。${failures >= 10 ? "强恢复提醒：再次尝试前先检查环境及实际错误，并提出具体的新假设。" : "恢复提醒：选择不同方法。"}`,
    `shell已失败${failures}次，期间无成功检查/编辑/验证。换方法：查实际错误、可用命令和当前shell，或写脚本；别再变换引号。工具仍可用。${failures >= 10 ? "强提醒：先查环境/错误，提出具体新假设再试。" : "提醒：改用不同方法。"}`,
  )
}

export function repeatedResult(attempts: number) {
  return select(
    `Repeated result (${attempts}): inputs, output and observed workspace/process state match. ${attempts >= 10 ? "Strong reminder: inspect the error and environment, state a new hypothesis and change approach." : "Inspect the retained result and choose a concrete change before retrying."} Tools remain available.`,
    `Repeated result (${attempts}): inputs, output and observed workspace/process state match. ${attempts >= 10 ? "Strong reminder: inspect error/environment, state a new hypothesis and change approach." : "Read retained output; choose a concrete change before retrying."} Tools remain available.`,
    `Repeated result (${attempts}): 输入、输出及观察到的工作区/进程状态相同。${attempts >= 10 ? "强提醒：检查错误和环境，提出新假设并改变方法。" : "查看保留结果，确定具体改变后再重试。"}工具仍然可用。`,
    `Repeated result (${attempts}): 输入/输出及所见工作区/进程状态相同。${attempts >= 10 ? "强提醒：查错误/环境，提新假设并换方法。" : "先读旧结果，确定改动再试。"}工具仍可用。`,
  )
}

export function executionFacts() {
  return select(
    "executableRemainingMs ends provider/tool admission before the host cleanup reserve. remainingMs includes that reserve; finish necessary checks and report actual job states before executionDeadline. Never restart running or unknown jobs.",
    "executableRemainingMs stops provider/tool admission before cleanup reserve; remainingMs includes reserve. Finish required checks and report actual job states before executionDeadline. Never restart running/unknown jobs.",
    "executableRemainingMs在宿主清理预留时间之前结束provider/工具准入；remainingMs包含该预留时间。请在executionDeadline前完成必要检查并报告实际任务状态，绝不重新启动运行中或状态未知的任务。",
    "executableRemainingMs截止即停止provider/工具准入，早于清理预留段；remainingMs含预留段。executionDeadline前完成必需检查并如实报任务状态；不重启运行中/未知任务。",
  )
}

export function advisoryFacts() {
  return select(
    "The advisory deadline is a planning reminder, not a stop condition. remainingMs, when present, is the enforced wall-clock budget.",
    "Advisory deadline: planning only, not a stop. remainingMs, if present, is the enforced wall-clock budget.",
    "建议截止时间仅用于规划提醒，不是停止条件。若有remainingMs，它表示强制执行的墙钟预算。",
    "建议截止仅供规划，不触发停止；remainingMs（若有）是强制墙钟预算。",
  )
}

export function gapFacts() {
  return select(
    "Preserve the current runnable artifact and address the smallest acceptance gap first. Do not omit requirements or necessary validation.",
    "Keep the runnable artifact; fix the smallest acceptance gap first. Omit no requirements or necessary validation.",
    "保留当前可运行产物，优先处理最小验收缺口；不得省略要求或必要验证。",
    "保留可运行产物，先补最小验收缺口；不省要求或必要验证。",
  )
}
