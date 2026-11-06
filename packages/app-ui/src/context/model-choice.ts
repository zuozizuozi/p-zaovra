type Choice = {
  id: string
  provider: { id: string }
  variants?: Record<string, unknown>
}

const suffix = /:(off|minimal|low|medium|high|xhigh|max)$/

export function isProviderAutoModel(id: string) {
  return /(^|\/)auto(?::|$)/i.test(id)
}

export function primaryProviderModel<T extends { id: string; type?: string }>(models: T[]) {
  const usable = models.filter((model) => !isProviderAutoModel(model.id) && (!model.type || model.type === "chat"))
  return usable.find((model) => !suffix.test(model.id)) ?? usable[0]
}

// Router aliases are wire model IDs, not interchangeable reasoning parameters.
export function groupModelChoices<T extends Choice>(models: T[]) {
  const keys = new Set(models.map((model) => `${model.provider.id}/${model.id}`))
  const aliases = new Map<string, Record<string, string>>()
  for (const model of models) {
    const match = suffix.exec(model.id)
    if (!match) continue
    const base = model.id.slice(0, match.index)
    const key = `${model.provider.id}/${base}`
    aliases.set(key, { ...aliases.get(key), [match[1]]: model.id })
  }
  const emitted = new Set<string>()
  return models.flatMap((model) => {
    if (isProviderAutoModel(model.id)) return []
    const match = suffix.exec(model.id)
    const base = match ? model.id.slice(0, match.index) : model.id
    const key = `${model.provider.id}/${base}`
    if (match && keys.has(key)) return []
    if (emitted.has(key)) return []
    emitted.add(key)
    return [
      {
        ...model,
        baseModelID: model.id,
        reasoningModels: aliases.get(key),
        reasoningDefault: !match,
      },
    ]
  })
}

export function modelVariantChoice(
  model: Choice & { baseModelID: string; reasoningModels?: Record<string, string> },
  value: string | undefined,
) {
  if (model.reasoningModels) {
    const modelID = value === undefined ? model.baseModelID : model.reasoningModels[value]
    if (!modelID) return
    return { modelID, variant: null }
  }
  if (value !== undefined && !Object.hasOwn(model.variants ?? {}, value)) return
  return { modelID: model.id, variant: value ?? null }
}

export function aliasModelVariant(model: { id: string; reasoningModels?: Record<string, string> } | undefined) {
  return Object.entries(model?.reasoningModels ?? {}).find(([, id]) => id === model?.id)?.[0]
}
