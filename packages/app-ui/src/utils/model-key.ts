export function parseModelKey(value: string) {
  const index = value.indexOf("/")
  if (index <= 0 || index === value.length - 1) return
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}
