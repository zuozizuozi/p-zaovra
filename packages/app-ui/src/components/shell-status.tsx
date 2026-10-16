import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

export type ShellStatusItem = {
  path: string
  effective?: boolean
  version?: string
  kind?: string
  source?: string
  error?: string
}

export function ShellStatus(props: { shells: readonly ShellStatusItem[] }) {
  const language = useLanguage()
  const platform = usePlatform()
  const active = () => props.shells.find((item) => item.effective)
  return (
    <Show when={active()}>
      {(shell) => (
        <div data-component="shell-status" class="text-12-regular text-text-weak break-all">
          <Show when={!shell().error} fallback={<p>{shell().error}</p>}>
            <p>
              {shell().kind === "powershell" ? "PowerShell" : shell().kind} {shell().version} · {shell().path} ·{" "}
              {language.t(
                shell().source === "project"
                  ? "settings.shell.project"
                  : shell().source === "global"
                    ? "settings.shell.global"
                    : "settings.shell.auto",
              )}
            </p>
            <Show
              when={
                shell().kind === "cmd" || (shell().kind === "powershell" && Number(shell().version?.split(".")[0]) < 7)
              }
            >
              <button
                class="text-left underline"
                onClick={() =>
                  platform.openLink(
                    "https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows",
                  )
                }
              >
                {language.t("settings.shell.install")}
              </button>
            </Show>
          </Show>
        </div>
      )}
    </Show>
  )
}
