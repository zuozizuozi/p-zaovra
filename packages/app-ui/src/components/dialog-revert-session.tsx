import type { Revert } from "@zaovra-ai/schema/revert"
import { createResource, For, onCleanup, Show } from "solid-js"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@zaovra-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { formatServerError } from "@/utils/server-errors"

type Plan = Pick<Revert.Plan, "coverage" | "token"> & { readonly files: readonly string[] }

export function useRevertConfirmation() {
  const dialog = useDialog()
  const sdk = useSDK()
  return (input: { sessionID: string; messageID: string }) => {
    const client = sdk().client
    return new Promise<Plan | undefined>((resolve) => {
      dialog.show(
        () => (
          <DialogRevertSession
            load={() => client.v2.session.revert.plan(input, { throwOnError: true }).then((result) => result.data.data)}
            onCancel={() => resolve(undefined)}
            onConfirm={(plan) => {
              resolve(plan)
              dialog.close()
            }}
          />
        ),
        () => resolve(undefined),
      )
    })
  }
}

export function DialogRevertSession(props: {
  load: () => Promise<Plan>
  onCancel: () => void
  onConfirm: (plan: Plan) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [plan, actions] = createResource(props.load)
  const ready = () => (plan.state === "ready" ? plan() : undefined)
  onCleanup(props.onCancel)
  return (
    <Dialog fit containerClass="max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)]">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("session.revert.confirmTitle")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div class="flex max-h-[calc(100vh-142px)] flex-col gap-3 overflow-y-auto px-5 py-4 text-sm">
          <p>{language.t("session.revert.confirmDescription")}</p>
          <Show when={plan.loading}>
            <p role="status">{language.t("session.revert.loadingPlan")}</p>
          </Show>
          <Show when={plan.error}>
            <div role="alert" class="flex flex-col gap-2">
              <p>{language.t("session.revert.planFailed")}</p>
              <p class="break-words text-xs">{formatServerError(plan.error, language.t)}</p>
              <ButtonV2 variant="neutral" onClick={() => void Promise.resolve(actions.refetch()).catch(() => {})}>
                {language.t("artifact.retry")}
              </ButtonV2>
            </div>
          </Show>
          <Show when={ready()}>
            {(value) => (
              <>
                <Show when={value().files.length} fallback={<strong>{language.t("session.revert.noFiles")}</strong>}>
                  <div>
                    <p>{language.t("session.revert.files", { count: value().files.length })}</p>
                    <ul class="mt-2 max-h-48 list-disc overflow-auto break-words pl-5">
                      <For each={value().files}>{(file) => <li class="py-0.5 font-mono text-xs">{file}</li>}</For>
                    </ul>
                  </div>
                </Show>
                <p>
                  {language.t(
                    value().coverage === "file-tools" ? "session.revert.fileToolsOnly" : "session.revert.listedOnly",
                  )}
                </p>
              </>
            )}
          </Show>
          <p class="font-medium">{language.t("session.revert.permanentWarning")}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" autofocus onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={!ready()}
          onClick={() => {
            const value = ready()
            if (value) props.onConfirm(value)
          }}
        >
          {language.t("session.revert.confirm")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
