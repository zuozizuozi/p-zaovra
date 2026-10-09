import { expect, test } from "bun:test"
import { artifactViewer } from "./artifact-preview"

test("remote PDFs use the browser, local PDFs use the desktop reader", () => {
  for (const target of [
    "https://example.test/report.pdf",
    "HTTP://localhost:3000/a.PDF",
    "https://example.test/a.pdf?download=1",
  ])
    expect(artifactViewer(target)).toBe("browser")
  for (const target of ["report.pdf", "C:\\project\\report.pdf", "/project/report.PDF"])
    expect(artifactViewer(target)).toBe("pdf")
})
