export function moveSidebarItem(keys: string[], source: string, target: string) {
  if (source === target || !keys.includes(source) || !keys.includes(target)) return keys
  const next = keys.filter((key) => key !== source)
  next.splice(keys.indexOf(target), 0, source)
  return next
}

export function sortSidebarItems<T>(items: T[], order: string[], key: (item: T) => string) {
  const rank = new Map(order.map((key, index) => [key, index]))
  return items.toSorted((a, b) => (rank.get(key(a)) ?? order.length) - (rank.get(key(b)) ?? order.length))
}

export function sortSidebarSessions<T extends { id: string; time: { created: number } }>(items: T[], order: string[]) {
  const sorted = items.toSorted((a, b) => b.time.created - a.time.created || b.id.localeCompare(a.id))
  const byID = new Map(items.map((item) => [item.id, item]))
  const known = [...new Set(order)].flatMap((id) => byID.get(id) ?? [])
  if (!known.length) return sorted
  const ranked = new Set(order)
  const newest = Math.max(...known.map((item) => item.time.created))
  // Newly admitted sessions go first; older pages loaded later stay below the saved order.
  return [
    ...sorted.filter((item) => !ranked.has(item.id) && item.time.created > newest),
    ...known,
    ...sorted.filter((item) => !ranked.has(item.id) && item.time.created <= newest),
  ]
}
export function createSidebarOrder(input: {
  read: () => { projectOrder?: string[]; sessionOrder?: Record<string, string[]> }
  writeProjects: (keys: string[]) => void
  writeSessions: (group: string, ids: string[]) => void
}) {
  return {
    projectOrder: () => input.read().projectOrder ?? [],
    setProjectOrder: (keys: string[]) => input.writeProjects([...new Set(keys)]),
    sessionOrder: (group: string) => input.read().sessionOrder?.[group] ?? [],
    setSessionOrder: (group: string, ids: string[]) => input.writeSessions(group, [...new Set(ids)]),
  }
}
