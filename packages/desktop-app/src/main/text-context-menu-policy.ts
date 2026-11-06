import type { ContextMenuParams, MenuItemConstructorOptions } from "electron"

export function editableTextMenu(
  params: Pick<ContextMenuParams, "isEditable" | "editFlags">,
  locale: string,
): MenuItemConstructorOptions[] {
  if (!params.isEditable) return []
  const labels = locale.toLowerCase().startsWith("zh")
    ? { cut: "剪切", copy: "复制", paste: "粘贴", selectAll: "全选" }
    : { cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All" }
  return [
    { role: "cut", label: labels.cut, enabled: params.editFlags.canCut },
    { role: "copy", label: labels.copy, enabled: params.editFlags.canCopy },
    { role: "paste", label: labels.paste, enabled: params.editFlags.canPaste },
    { role: "selectAll", label: labels.selectAll, enabled: params.editFlags.canSelectAll },
  ]
}
