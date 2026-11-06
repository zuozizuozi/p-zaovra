import { expect, test } from "bun:test"
import { editableTextMenu } from "./text-context-menu-policy"
const editFlags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false,
}
test("697 non-editable content has no native default menu", () => {
  expect(editableTextMenu({ isEditable: false, editFlags }, "zh")).toEqual([])
})
test("697 text editing follows the interface language and enabled flags", () => {
  const zh = editableTextMenu({ isEditable: true, editFlags: { ...editFlags, canCut: false } }, "zh-CN")
  expect(zh.map((item) => item.label)).toEqual(["剪切", "复制", "粘贴", "全选"])
  expect(zh[0].enabled).toBe(false)
  expect(zh.map((item) => item.role)).toEqual(["cut", "copy", "paste", "selectAll"])
  expect(editableTextMenu({ isEditable: true, editFlags }, "en").map((item) => item.label)).toEqual([
    "Cut",
    "Copy",
    "Paste",
    "Select All",
  ])
})
