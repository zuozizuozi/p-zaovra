import { expect, test } from "bun:test"
import { resolveReviewFilePath } from "./review-file-path"

test("resolves review files from their worktree instead of the active subdirectory", () => {
  expect(resolveReviewFilePath("/repo", "packages/app/image.png")).toBe("/repo/packages/app/image.png")
  expect(resolveReviewFilePath("C:\\repo\\", "packages/app/image.png")).toBe("C:\\repo/packages/app/image.png")
  expect(resolveReviewFilePath("/", "image.png")).toBe("/image.png")
  expect(resolveReviewFilePath("\\\\host\\share", "image.png")).toBe("\\\\host\\share/image.png")
})

test("preserves absolute paths and literal filename characters", () => {
  expect(resolveReviewFilePath("/repo", "/repo/image.png")).toBe("/repo/image.png")
  expect(resolveReviewFilePath("C:\\repo", "C:\\repo\\image.png")).toBe("C:\\repo\\image.png")
  expect(resolveReviewFilePath("/repo", "dir/a #1%.png")).toBe("/repo/dir/a #1%.png")
})
