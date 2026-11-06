import { createSignal } from "solid-js"
import { MenuV2 } from "@zaovra-ai/ui/v2/menu-v2"
import { DialogV2, DialogHeader, DialogTitleGroup, DialogFooter } from "@zaovra-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import type { ServerCtx } from "@/context/global"
import type { ServerConnection } from "@/context/server"
import type { Session } from "@zaovra-ai/sdk/v2"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"

export function SidebarSessionActions(props: {
  session: Session
  server: ServerConnection.Key
  ctx: ServerCtx
  rename: () => void
}) {
  // Archiving/deleting can remove the reactive row before the request resolves.
  const session = props.session
  const language = useLanguage()
  const dialog = useDialog()
  const tabs = useTabs()
  const [, setStore] = props.ctx.sync.child(session.directory, { bootstrap: false })
  const [busy, setBusy] = createSignal(false)
  const client = () => props.ctx.sdk.createClient({ directory: session.directory, throwOnError: true })
  const remove = async (deleting = false) => {
    if (busy()) return false
    setBusy(true)
    return (
      deleting
        ? client().v2.session.remove({ sessionID: session.id })
        : client().v2.session.update({ sessionID: session.id, archived: true })
    )
      .then(() => {
        setStore("session", (items) => items.filter((item) => item.id !== session.id))
        tabs.removeSessions({
          server: props.server,
          directory: session.directory,
          sessionIDs: [session.id],
        })
        return true
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : undefined,
        })
        return false
      })
      .finally(() => setBusy(false))
  }
  function ConfirmDelete() {
    return (
      <DialogV2 fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", { name: session.title })}
          />
        </DialogHeader>
        <DialogFooter>
          <ButtonV2 variant="ghost" disabled={busy()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="danger"
            disabled={busy()}
            onClick={async () => {
              if (await remove(true)) dialog.close()
            }}
          >
            {language.t("session.delete.button")}
          </ButtonV2>
        </DialogFooter>
      </DialogV2>
    )
  }
  return (
    <>
      <MenuV2.Item disabled={busy()} onSelect={props.rename}>
        {language.t("common.rename")}
      </MenuV2.Item>
      <MenuV2.Item disabled={busy()} onSelect={() => void remove()}>
        {language.t("command.session.archive")}
      </MenuV2.Item>
      <MenuV2.Separator />
      <MenuV2.Item disabled={busy()} onSelect={() => dialog.show(() => <ConfirmDelete />)}>
        {language.t("session.delete.button")}
      </MenuV2.Item>
    </>
  )
}
