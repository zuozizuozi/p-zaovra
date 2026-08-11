import type { CommandView, CommandV2Info, PermissionView, PermissionV2Request } from "@zaovra-ai/sdk/v2"

export function adaptCommand(command: CommandV2Info): CommandView {
  return {
    ...command,
    model: command.model ? `${command.model.providerID}/${command.model.id}` : undefined,
    source: "command",
    hints: [],
  }
}

export function adaptPermissionRequest(request: PermissionV2Request): PermissionView {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    always: request.save ?? request.resources,
    metadata: request.metadata ?? {},
    ...(request.source ? { tool: { messageID: request.source.messageID, callID: request.source.callID } } : {}),
  }
}
