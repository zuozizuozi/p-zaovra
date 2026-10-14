// The tool contract marks recommendations in labels; preserve original reply values.
export function questionOptions<T extends { label: string }>(options: readonly T[]) {
  return options
    .map((option) => ({
      ...option,
      recommended: /\s*[（(](?:Recommended|推荐)[)）]$/i.test(option.label),
      displayLabel: option.label.replace(/\s*[（(](?:Recommended|推荐)[)）]$/i, ""),
    }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended))
}
