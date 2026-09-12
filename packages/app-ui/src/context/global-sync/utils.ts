import type {
  Agent,
  AgentV2Info,
  CommandView,
  CommandV2Info,
  PermissionView,
  PermissionV2Request,
  Project,
  ProviderListResponse,
} from "@zaovra-ai/sdk/v2/client"
import { NormalizedProviderListResponse } from "@zaovra-ai/session-ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function adaptCommand(command: CommandV2Info): CommandView {
  return {
    ...command,
    model: command.model ? `${command.model.providerID}/${command.model.id}` : undefined,
    variant: command.model?.variant,
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

export function adaptAgent(agent: AgentV2Info): Agent {
  return {
    name: agent.id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
    color: agent.color,
    steps: agent.steps,
    permission: agent.permissions,
    model: agent.model && { modelID: agent.model.id, providerID: agent.model.providerID },
    variant: agent.model?.variant,
    prompt: agent.system,
    options: agent.request.body,
  }
}

export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  return {
    ...input,
    all: new Map(
      input.all.map(
        (provider) =>
          [
            provider.id,
            {
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            },
          ] as const,
      ),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
