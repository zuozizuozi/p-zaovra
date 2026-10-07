import { useLanguage } from "@/context/language"
import { BrandMark } from "./brand-mark"

export function DraftLoading() {
  const language = useLanguage()
  return (
    <div
      data-component="draft-loading"
      role="status"
      class="flex size-full min-h-64 flex-col items-center justify-center gap-6 p-6"
    >
      <BrandMark class="size-12" />
      <p class="text-v2-text-text-muted">{language.t("common.loading")}</p>
      <div
        aria-hidden="true"
        class="h-28 w-full max-w-xl rounded-xl border border-v2-border-border-muted bg-v2-background-bg-layer-01"
      />
    </div>
  )
}
