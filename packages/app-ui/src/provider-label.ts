const brands = new Map([
  ["api.gravitex.ai", "万引"],
  ["api.edgecloudapp.com", "EdgeCloud"],
  ["api.deepseek.com", "DeepSeek"],
  ["api.openai.com", "OpenAI"],
  ["api.anthropic.com", "Anthropic"],
  ["openrouter.ai", "OpenRouter"],
  ["generativelanguage.googleapis.com", "Google Gemini"],
])

export function providerDisplayName(name?: string, endpoint?: string) {
  const value = name?.trim() ?? ""
  const address = URL.canParse(value)
    ? value
    : /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(value)
      ? `https://${value}`
      : undefined
  if (value && !address) return value
  const url = address ?? endpoint
  const host = url && URL.canParse(url) ? new URL(url).hostname : undefined
  return (host && brands.get(host)) || (host ? `API · ${host}` : value || "Custom API")
}
