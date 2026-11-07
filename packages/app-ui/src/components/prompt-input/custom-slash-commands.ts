import type { CommandView } from "@zaovra-ai/sdk/v2/client"

export function customSlashCommands(commands: CommandView[], fallback: (name: string) => string) {
  return commands
    .filter((command) => command.name !== "bug")
    .map((command) => ({
      id: `custom.${command.source}.${command.name}`,
      trigger: command.name,
      title: command.name,
      description: command.description || fallback(command.name),
      type: "custom" as const,
      source: command.source ?? "command",
    }))
}
