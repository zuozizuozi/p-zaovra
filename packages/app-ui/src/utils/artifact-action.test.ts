import { expect, test } from "bun:test"
import { createArtifactAction } from "./artifact-action"

test("local HTML, image and PDF actions reveal files without directory-only openPath", async () => {
  const revealed: string[] = []
  const opened: string[] = []
  const errors: string[] = []
  const action = createArtifactAction({
    openLink: () => {},
    openPath: async (path) => { opened.push(path); throw new Error("Only directories can be opened") },
    revealPath: async (path) => { revealed.push(path); return true },
  }, () => { errors.push("visible error") })
  for (const file of ["成果 空格.html", "image.png", "report.pdf"]) await action(file, "C:/project")
  expect(revealed).toEqual(["C:/project/成果 空格.html", "C:/project/image.png", "C:/project/report.pdf"])
  expect(opened).toEqual([])
  expect(errors).toEqual([])
})

test("missing file, unavailable reveal and IPC rejection all report a visible failure", async () => {
  const errors: number[] = []
  for (const revealPath of [undefined, async () => false, async () => { throw new Error("IPC failed") }]) {
    await createArtifactAction({ openLink: () => {}, revealPath }, () => { errors.push(1) })("file.pdf", "/project")
  }
  expect(errors).toHaveLength(3)
})

test("web links retain browser opening", async () => {
  const links: string[] = []
  await createArtifactAction({ openLink: (url) => { links.push(url) } }, () => { throw new Error("unexpected") })("https://example.com/a.pdf", "/project")
  expect(links).toEqual(["https://example.com/a.pdf"])
})

test("outside-project and executable targets never reach the host", async () => {
  const revealed: string[] = []
  const errors: number[] = []
  const action = createArtifactAction({ openLink: () => {}, revealPath: async (path) => { revealed.push(path); return true } }, () => { errors.push(1) })
  for (const target of ["../outside.pdf", "C:/other/file.pdf", "run.exe", "run.ps1"]) await action(target, "C:/project")
  expect(revealed).toEqual([])
  expect(errors).toHaveLength(4)
})

test("repeated clicks while revealing are coalesced and retry is possible afterward", async () => {
  const pending = Promise.withResolvers<boolean>()
  const paths: string[] = []
  const action = createArtifactAction({ openLink: () => {}, revealPath: (path) => { paths.push(path); return pending.promise } }, () => {})
  const first = action("file.pdf", "/project")
  await action("file.pdf", "/project")
  expect(paths).toHaveLength(1)
  pending.resolve(true)
  await first
  await action("file.pdf", "/project")
  expect(paths).toHaveLength(2)
})
