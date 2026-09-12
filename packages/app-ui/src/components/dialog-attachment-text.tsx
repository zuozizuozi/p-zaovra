import { Dialog, DialogHeader, DialogTitle, DialogBody } from "@zaovra-ai/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"

export function DialogAttachmentText(props: { name: string; dataUrl: string }) {
  const language = useLanguage()
  const content = () => {
    const encoded = props.dataUrl.slice(props.dataUrl.indexOf(",") + 1)
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)))
  }
  return (
    <Dialog size="large">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{props.name}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 text-sm select-text">
          {content()}
        </pre>
      </DialogBody>
    </Dialog>
  )
}
