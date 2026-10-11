import { Show, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { BrandMark } from "../brand-mark"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"

export function SettingsAbout() {
  const platform = usePlatform()
  const [state, setState] = createStore<{ document?: "license" | "notices" }>({})
  const [text] = createResource(
    () => state.document,
    (document) => platform.legalDocument?.(document),
  )
  return (
    <div class="settings-v2-tab-body">
      <BrandMark class="size-16" />
      <h2 class="text-24-semibold">Zaovra</h2>
      <p>版本 {platform.version ?? "开发版"}</p>
      <p>Copyright © 2026 Zaovra contributors</p>
      <Show when={platform.legalDocument}>
        <div class="flex gap-3">
          <ButtonV2 variant="neutral" onClick={() => setState("document", "license")}>
            开源许可
          </ButtonV2>
          <ButtonV2 variant="neutral" onClick={() => setState("document", "notices")}>
            第三方声明
          </ButtonV2>
        </div>
        <Show when={text.loading}>
          <p>正在读取…</p>
        </Show>
        <Show when={text.error}>
          <p>无法读取随包声明，请检查安装文件。</p>
        </Show>
        <Show when={text()}>
          <pre class="whitespace-pre-wrap break-words text-12-regular">{text()}</pre>
        </Show>
      </Show>
    </div>
  )
}
