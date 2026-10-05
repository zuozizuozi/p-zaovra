import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { useLanguage } from "@/context/language"
import mascot from "@/assets/zaovra-idle.png"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  const language = useLanguage()
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div data-slot="new-session-position" class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div data-slot="new-session-content" class={NEW_SESSION_CONTENT_WIDTH}>
          <header data-slot="new-session-heading">
            <div
              data-slot="brand-placeholder"
              data-placement="empty"
              class="mb-5 flex justify-center"
              role="img"
              aria-label="Zaovra"
            >
              <img src={mascot} class="size-14 object-contain" alt="" />
            </div>
            <h1 class="text-20-medium text-v2-text-text-base">{language.t("session.new.title")}</h1>
          </header>
          <div data-slot="new-session-body">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
