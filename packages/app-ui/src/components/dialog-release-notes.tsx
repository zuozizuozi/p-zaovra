import { createStore } from "solid-js/store"
import type { ReleaseHighlight } from "@/release-notes"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { Button } from "@zaovra-ai/ui/button"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

export function DialogReleaseNotes(props: { version: string; highlights: ReleaseHighlight[] }) {
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()
  const [state, setState] = createStore({ index: 0 })

  const total = () => props.highlights.length
  const last = () => Math.max(0, total() - 1)
  const feature = () => props.highlights[state.index] ?? props.highlights[last()]
  const isFirst = () => state.index === 0
  const isLast = () => state.index >= last()
  const paged = () => total() > 1

  function handleNext() {
    if (isLast()) return
    setState("index", state.index + 1)
  }

  function handleClose() {
    dialog.close()
  }

  function handleDisable() {
    settings.general.setReleaseNotes(false)
    handleClose()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      handleClose()
      return
    }

    if (!paged()) return
    if (e.key === "ArrowLeft" && !isFirst()) {
      e.preventDefault()
      setState("index", state.index - 1)
    }
    if (e.key === "ArrowRight" && !isLast()) {
      e.preventDefault()
      setState("index", state.index + 1)
    }
  }

  return (
    <Dialog
      title={language.t("dialog.releaseNotes.title", { version: props.version })}
      size="large"
      fit
      class="w-[min(calc(100vw-40px),720px)] h-[min(calc(100vh-40px),400px)] min-h-0 overflow-hidden"
    >
      <div class="flex flex-1 min-w-0 min-h-0" tabIndex={0} autofocus onKeyDown={handleKeyDown}>
        {/* Left side - Text content */}
        <div class="flex flex-col flex-1 min-w-0 p-8">
          {/* Top section - feature content (fixed position from top) */}
          <div class="flex flex-col gap-2 pt-8 overflow-y-auto">
            <div class="flex items-center gap-2">
              <h1 class="text-16-medium text-text-strong">{feature()?.title ?? ""}</h1>
              {feature()?.focus && (
                <span class="text-12-medium text-text-weak">{language.t("dialog.releaseNotes.focus")}</span>
              )}
            </div>
            <p class="text-14-regular text-text-base">{feature()?.description ?? ""}</p>
          </div>

          {/* Spacer to push buttons to bottom */}
          <div class="flex-1" />

          {/* Bottom section - buttons and indicators (fixed position) */}
          <div class="flex flex-col gap-12">
            <div class="flex flex-col items-start gap-3">
              {isLast() ? (
                <Button variant="primary" size="large" onClick={handleClose}>
                  {language.t("dialog.releaseNotes.action.getStarted")}
                </Button>
              ) : (
                <Button variant="secondary" size="large" onClick={handleNext}>
                  {language.t("dialog.releaseNotes.action.next")}
                </Button>
              )}

              <Button variant="ghost" size="small" onClick={handleDisable}>
                {language.t("dialog.releaseNotes.action.hideFuture")}
              </Button>
            </div>

            {paged() && (
              <div class="flex items-center gap-1.5 -my-2.5">
                {props.highlights.map((_, i) => (
                  <button
                    type="button"
                    class="h-6 flex items-center cursor-pointer bg-transparent border-none p-0 transition-all duration-200"
                    classList={{
                      "w-8": i === state.index,
                      "w-3": i !== state.index,
                    }}
                    onClick={() => setState("index", i)}
                  >
                    <div
                      class="w-full h-0.5 rounded-[1px] transition-colors duration-200"
                      classList={{
                        "bg-icon-strong-base": i === state.index,
                        "bg-icon-weak-base": i !== state.index,
                      }}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
