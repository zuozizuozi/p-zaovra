import { For, Show } from "solid-js"
import { MenuV2 } from "@zaovra-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import type { PermissionMode } from "@/context/permission-auto-respond"

export function PermissionModeControl(props: { mode: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  const language = useLanguage()
  return (
    <div class="min-w-0" data-component="permission-mode-control">
      <MenuV2>
        <MenuV2.Trigger
          data-component="permission-chip"
          data-mode={props.mode}
          class="h-7 min-w-0 max-w-full truncate rounded-full px-2 text-xs"
          classList={{
            "bg-v2-background-bg-layer-02": props.mode !== "full",
            "border border-border-critical-base text-text-on-critical-base": props.mode === "full",
          }}
          title={language.t("permission.mode." + props.mode + ".description")}
        >
          {language.t("permission.mode." + props.mode)} ⌄
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <For each={["ask", "automatic", "full"] as const}>
              {(mode) => (
                <MenuV2.Item onSelect={() => props.onChange(mode)}>
                  <div class="flex max-w-80 flex-col gap-1">
                    <span>{language.t("permission.mode." + mode)}</span>
                    <span class="text-xs text-text-weak whitespace-normal">
                      {language.t("permission.mode." + mode + ".description")}
                    </span>
                  </div>
                </MenuV2.Item>
              )}
            </For>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <Show when={props.mode === "full"}>
        <p
          role="status"
          class="mt-1 rounded-md bg-surface-critical-base p-2 text-xs text-text-on-critical-base max-w-80"
          data-slot="full-access-warning"
        >
          {language.t("permission.mode.full.warning")}
        </p>
      </Show>
    </div>
  )
}
