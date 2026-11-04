import { useLanguage } from "@/context/language"

export function ProviderEnableChoice(props: {
  disconnected: boolean
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-2 text-14-regular text-text-base">
      <p>
        {language.t(props.disconnected ? "provider.connect.disabled.disconnect" : "provider.connect.disabled.config")}
      </p>
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          disabled={props.disabled}
          checked={props.checked}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
        />
        {language.t("provider.connect.disabled.enable")}
      </label>
    </div>
  )
}
