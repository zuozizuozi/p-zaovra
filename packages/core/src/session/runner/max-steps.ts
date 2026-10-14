export function maxStepsPrompt(reason: string) {
  return `Tool execution has stopped: ${reason}.

Respond with text only. Do not request more tools.

Report the completed work and the specific stopping reason. Use the retained tool results to distinguish checks that passed, checks that failed, and checks that never ran. Keep each result within its observed scope and current file state; a passing check does not prove the whole task is complete.

List only work that actually remains unfinished or unverified. Do not invent pending checks or describe an observed completed check as never run. If relevant files changed after a check, explain that its result may be stale. Give the next action only when work remains. Do not claim overall success merely because a final text response was produced.`
}
