import { createSignal, onCleanup, type JSX } from "solid-js"
import { newSessionGreeting } from "@/pages/session/new-session-greeting"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { useLanguage } from "@/context/language"
import { IdleMascot } from "@/components/idle-mascot"
import { EmptyBinaryBackground } from "./empty-binary-background"

export function NewSessionDesignView(props: { children: JSX.Element; heading?: string; options?: JSX.Element }) {
  const language = useLanguage()
  const [hour, setHour] = createSignal(new Date().getHours())
  const timer = setInterval(() => setHour(new Date().getHours()), 60_000)
  onCleanup(() => clearInterval(timer))
  return (
    <div data-component="session-new-design" class="relative size-full overflow-y-auto bg-v2-background-bg-deep ">
      <EmptyBinaryBackground />
      <div
        data-slot="new-session-position"
        class="relative flex min-h-full justify-center px-6 pb-8 pt-[clamp(32px,12vh,120px)]"
      >
        <div data-slot="new-session-content" class={NEW_SESSION_CONTENT_WIDTH}>
          <header data-slot="new-session-heading" class="text-center">
            <div
              data-slot="brand-placeholder"
              data-placement="empty"
              class="mb-5 flex justify-center"
              role="img"
              aria-label="Zaovra"
            >
              <IdleMascot class="size-[72px]" />
            </div>
            <h1 class="text-20-medium text-v2-text-text-base">
              {props.heading ?? language.t(newSessionGreeting(hour()))}
            </h1>
            <p class="mt-2 text-sm text-v2-text-text-muted">{language.t("session.new.greeting.prompt")}</p>
          </header>
          <div data-slot="new-session-body">{props.children}</div>
          {props.options}
        </div>
      </div>
    </div>
  )
}
