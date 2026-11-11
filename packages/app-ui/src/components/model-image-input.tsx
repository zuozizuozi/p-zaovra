import { createUniqueId, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { imageReference } from "./model-images"

export function ModelImageInput(props: {
  modelID: string
  checked?: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const language = useLanguage()
  const sync = useServerSync()
  const description = createUniqueId()
  const reference = () => imageReference(props.modelID, sync().data.provider.all.values(), sync().data.config.provider)
  return (
    <div data-component="model-image-input" class="flex min-w-0 flex-col gap-1">
      <label class="flex min-h-10 items-center gap-2 text-14-regular">
        <input
          type="checkbox"
          checked={props.checked ?? false}
          disabled={props.disabled}
          aria-describedby={description}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
        />
        <span class="break-all">
          {props.modelID} · {language.t("provider.custom.models.images")}
        </span>
      </label>
      <p id={description} class="text-12-regular text-text-weak">
        {language.t("provider.models.imageHint")}
      </p>
      <Show when={reference()}>
        {(provider) => (
          <p class="text-12-regular text-text-weak">
            {language.t("provider.models.imageReference", { provider: provider() })}
          </p>
        )}
      </Show>
    </div>
  )
}
