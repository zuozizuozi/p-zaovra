import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"

export function DialogSessionDeleteFailed(props: {
  session: string
  workspace: string
  onDelete?: () => boolean | void | Promise<boolean | void>
  onDone?: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()

  async function confirm() {
    const result = await props.onDelete?.()
    if (result === false) return
    props.onDone?.()
    if (!props.onDone) dialog.clear()
  }

  useBindings(() => ({
    bindings: [{ key: "return", desc: "Delete unavailable workspace", group: "Dialog", cmd: () => void confirm() }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Failed to Delete Session
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {`The session "${props.session}" could not be deleted because the workspace "${props.workspace}" is not available.`}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        This workspace cannot be restored by SessionV2. You can remove its unavailable workspace record.
      </text>
      <box
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.primary}
        onMouseUp={() => void confirm()}
      >
        <text attributes={TextAttributes.BOLD} fg={theme.selectedListItemText}>
          Delete unavailable workspace
        </text>
        <text fg={theme.selectedListItemText} wrapMode="word">
          Delete the workspace record and all sessions attached to it.
        </text>
      </box>
    </box>
  )
}
