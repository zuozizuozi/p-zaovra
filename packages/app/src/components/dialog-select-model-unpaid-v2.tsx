import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@zaovra-ai/ui/v2/dialog-v2"
import { ProviderIcon } from "@zaovra-ai/ui/provider-icon"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useTheme } from "@zaovra-ai/ui/theme"
import { type Component, For, Show } from "solid-js"
import { useLocal } from "@/context/local"
import { useProviders } from "@/hooks/use-providers"
import { decode64 } from "@/utils/base64"
import { useLanguage } from "@/context/language"

type ModelState = ReturnType<typeof useLocal>["model"]
const featuredProviders = ["zaovra", "zaovra-go", "openai", "anthropic", "google", "github-copilot"]

export const DialogSelectModelUnpaidV2: Component<{ model?: ModelState }> = () => {
  const local = useLocal()
  const dialog = useDialog()
  const theme = useTheme()
  const directory = () => decode64(local.slug())
  const providers = useProviders(directory)
  const language = useLanguage()

  const openProviders = (provider?: string) => {
    void import("./dialog-connect-provider").then((x) => {
      const controller = x.useProviderConnectController()
      controller.select(provider)
      void dialog.show(() => <x.DialogConnectProvider controller={controller} directory={directory} />)
    })
  }

  return (
    <DialogV2
      fit
      containerClass="!h-auto max-h-[calc(100vh_-_16px)] !w-[min(calc(100vw_-_16px),640px)]"
      class="[font-family:var(--v2-font-family-sans)] [&_[data-slot=dialog-header]]:!px-5 [&_[data-slot=dialog-header-title]]:!text-[15px] [&_[data-slot=dialog-header-title]]:!tracking-[-0.13px]"
    >
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("dialog.model.select.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-h-[calc(100vh_-_68px)] min-h-0 flex-none gap-0 overflow-y-auto px-2 pb-2">
        <div class="flex min-h-0 flex-col">
          <div class="flex w-full flex-col">
            <div class="flex w-full flex-col items-start rounded-lg border-[0.5px] border-v2-border-border-muted bg-v2-background-bg-layer-02 p-2.5 pt-2">
              <div class="flex h-8 w-full select-none items-center px-0.5 pb-2">
                <div class="flex h-5 items-center text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-family:var(--v2-font-family-sans)] [font-variant-numeric:tabular-nums] [font-variation-settings:'slnt'_0]">
                  {language.t("dialog.model.unpaid.addMore.title")}
                </div>
              </div>
              <div class="grid w-full grid-cols-1 gap-y-1.5 gap-x-2 sm:grid-cols-2">
                <For
                  each={[...providers.popular()]
                    .filter((provider) => featuredProviders.includes(provider.id))
                    .sort((a, b) => featuredProviders.indexOf(a.id) - featuredProviders.indexOf(b.id))}
                >
                  {(provider) => (
                    <button
                      type="button"
                      class="flex min-h-11 w-full scroll-my-3.5 flex-row items-start gap-2 rounded-md bg-v2-background-bg-base px-3 py-2.5 text-left text-[13px] font-[530] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-family:var(--v2-font-family-sans)] [font-variation-settings:'slnt'_0] hover:bg-v2-background-bg-layer-01 focus:bg-v2-background-bg-layer-01 focus:outline-none"
                      classList={{
                        "border-[0.5px] border-transparent shadow-[var(--v2-elevation-raised)]":
                          theme.mode() !== "dark",
                        "border-[0.5px] border-v2-border-border-strong": theme.mode() === "dark",
                      }}
                      onClick={() => openProviders(provider.id)}
                    >
                      <ProviderIcon id={provider.id} class="mt-0.5 size-4 shrink-0 text-v2-icon-icon-base" />
                      <span class="flex min-w-0 flex-col">
                        <span class="truncate">{provider.name}</span>
                        <Show when={provider.id === "zaovra" || provider.id === "zaovra-go"}>
                          <span class="truncate font-[440] text-v2-text-text-muted">
                            {language.t(
                              provider.id === "zaovra"
                                ? "dialog.provider.zaovra.tagline"
                                : "dialog.provider.zaovraGo.tagline",
                            )}
                          </span>
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="col-span-full flex h-8 w-full scroll-my-3.5 items-center justify-start rounded-md px-3 text-left text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-family:var(--v2-font-family-sans)] [font-variation-settings:'slnt'_0] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                  onClick={() => openProviders()}
                >
                  {language.t("dialog.model.unpaid.viewMoreProviders")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
