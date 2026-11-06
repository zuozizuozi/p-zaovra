import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { LanguageProvider, loadLocaleDict } from "../../src/context/language"
import { PlatformProvider } from "../../src/context/platform"
import { ProviderModelFields } from "../../src/components/dialog-provider-models"
import { manualProviderModels, providerModelsPatch } from "../../src/components/provider-model-config"
import type { ProviderProtocol } from "../../src/provider-discovery"

test("707 actual Solid manual model IDs and protocol remain operable after discovery failure", async () => {
  await loadLocaleDict("zh")
  const [state, setState] = createStore({ value: "", protocol: undefined as ProviderProtocol | undefined })
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <PlatformProvider
        value={{
          platform: "web",
          openLink() {},
          restart: async () => {},
          back() {},
          forward() {},
          notify: async () => {},
        }}
      >
        <LanguageProvider locale="zh">
          <ProviderModelFields
            value={state.value}
            protocol={state.protocol}
            onChange={(value) => setState("value", value)}
            onProtocol={(protocol) => setState("protocol", protocol)}
          />
        </LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  try {
    await Promise.resolve()
    const input = root.querySelector("textarea")!
    const protocol = root.querySelector("select")!
    expect(input.closest("label")?.textContent).toContain("模型 ID")
    expect(root.textContent).toContain("不发送生成请求")
    input.value = "gateway-chat\nnamespace/reasoner:high"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    protocol.value = "responses"
    protocol.dispatchEvent(new Event("change", { bubbles: true }))
    expect(state.value).toBe("gateway-chat\nnamespace/reasoner:high")
    expect(state.protocol).toBe("responses")
    expect(providerModelsPatch("saved", manualProviderModels(state.value), undefined, state.protocol)).toMatchObject({
      model: "saved/gateway-chat",
      provider: { saved: { npm: "@ai-sdk/openai", whitelist: ["gateway-chat", "namespace/reasoner:high"] } },
    })
  } finally {
    dispose()
    root.remove()
  }
})
