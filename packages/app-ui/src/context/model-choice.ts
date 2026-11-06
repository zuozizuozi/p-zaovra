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

export function resolveModelKey(
  key: { providerID: string; modelID: string } | undefined,
  models: Array<{ id: string; provider: { id: string }; type?: string }>,
  valid: (key: { providerID: string; modelID: string }) => boolean,
) {
  if (!key) return
  if (!isProviderAutoModel(key.modelID)) return valid(key) ? key : undefined
  const concrete = primaryProviderModel(models.filter((model) => model.provider.id === key.providerID))
  if (concrete) return { providerID: key.providerID, modelID: concrete.id }
}

export function resolveModelSelection<T extends Choice>(input: {
  selected?: { providerID: string; modelID: string }
  agent?: { providerID: string; modelID: string }
  configured?: { providerID: string; modelID: string }
  recent: Array<{ providerID: string; modelID: string }>
  providers: Array<{ id: string; models: Record<string, { id: string }> }>
  defaults: Record<string, string>
  models: T[]
  valid: (key: { providerID: string; modelID: string }) => boolean
  find: (key: { providerID: string; modelID: string }) => T | undefined
}) {
  if (input.selected) {
    const key = resolveModelKey(input.selected, input.models, input.valid)
    return key ? input.find(key) : undefined
  }
  for (const candidate of [input.agent, input.configured, ...input.recent]) {
    if (!candidate?.modelID) continue
    const key = resolveModelKey(candidate, input.models, input.valid)
    if (key) return input.find(key)
    // An automatic route is still a chosen billing source, even when empty.
    if (isProviderAutoModel(candidate.modelID)) return
  }
  for (const provider of input.providers) {
    const modelID = input.defaults[provider.id] ?? Object.values(provider.models)[0]?.id
    if (!modelID) continue
    const key = resolveModelKey({ providerID: provider.id, modelID }, input.models, input.valid)
    if (key) return input.find(key)
    if (isProviderAutoModel(modelID)) return
  }
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
