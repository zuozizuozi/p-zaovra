import type { CommandV2Info, PermissionV2Request, QuestionV2Request } from "./gen/types.gen.js"

export type CommandView = Omit<CommandV2Info, "model"> & {
  model?: string
  source: "command" | "mcp" | "skill"
  hints: Array<string>
}

export type PermissionView = {
  id: PermissionV2Request["id"]
  sessionID: PermissionV2Request["sessionID"]
  permission: PermissionV2Request["action"]
  patterns: PermissionV2Request["resources"]
  always: PermissionV2Request["resources"]
  metadata: NonNullable<PermissionV2Request["metadata"]>
  tool?: {
    messageID: NonNullable<PermissionV2Request["source"]>["messageID"]
    callID: NonNullable<PermissionV2Request["source"]>["callID"]
  }
}

export type QuestionView = QuestionV2Request
