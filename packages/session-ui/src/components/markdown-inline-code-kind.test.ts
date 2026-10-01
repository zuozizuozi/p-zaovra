import { describe, expect, test } from "bun:test"
import { inlineCodeKind } from "./markdown-inline-code-kind"

describe("inlineCodeKind", () => {
  test("keeps commands ending in file names as code", () => {
    for (const command of [
      "bun test foo.ts",
      "python make_poster.py",
      "git add README.md",
      "cp a.png b.png",
      "npm i && node build.js",
      "convert in.jpg -resize 50% out.png",
      "tool -x out.png",
      "echo ok; out.png",
    ])
      expect(inlineCodeKind(command)).toBeUndefined()
  })
  test("recognizes image and document paths including spaces", () => {
    for (const path of ["结果.png", "报告 final.pdf", "image.JPEG", "table.xlsx", "src/my file.ts:12", "slides.pptx"])
      expect(inlineCodeKind(path)).toBe("path")
  })
  test("leaves code expressions as normal inline code", () => {
    expect(
      inlineCodeKind(
        `case "question.asked": ... input.setStore("question", question.sessionID, [question]) / splice/insert`,
      ),
    ).toBeUndefined()
    expect(inlineCodeKind(`<SessionQuestionDock request={request} ... />`)).toBeUndefined()
    expect(inlineCodeKind(`from sync.data.question + sync.data.session.`)).toBeUndefined()
    expect(inlineCodeKind(`@zaovra-ai/app <StatusPopover />)`)).toBeUndefined()
    expect(inlineCodeKind(`sync.data.session`)).toBeUndefined()
    expect(inlineCodeKind(`window.api`)).toBeUndefined()
    expect(inlineCodeKind(`1.2`)).toBeUndefined()
  })

  test("detects file and directory paths", () => {
    expect(inlineCodeKind(`app.tsx`)).toBe("path")
    expect(inlineCodeKind(`vite.config.mjs`)).toBe("path")
    expect(inlineCodeKind(`eslint.config.cjs`)).toBe("path")
    expect(inlineCodeKind(`app.d.ts`)).toBe("path")
    expect(inlineCodeKind(`component.svelte`)).toBe("path")
    expect(inlineCodeKind(`schema.graphql`)).toBe("path")
    expect(inlineCodeKind(`Dockerfile`)).toBe("path")
    expect(inlineCodeKind(`Dockerfile.dev`)).toBe("path")
    expect(inlineCodeKind(`.gitignore`)).toBe("path")
    expect(inlineCodeKind(`Cargo.lock`)).toBe("path")
    expect(inlineCodeKind(`go.sum`)).toBe("path")
    expect(inlineCodeKind(`bun.lockb`)).toBe("path")
    expect(inlineCodeKind(`terraform.tfvars`)).toBe("path")
    expect(inlineCodeKind(`pnpm-lock.yaml`)).toBe("path")
    expect(inlineCodeKind(`packages/desktop-electron`)).toBe("path")
    expect(inlineCodeKind(`~/.config/zaovra`)).toBe("path")
    expect(inlineCodeKind(`@zaovra-ai/app`)).toBe("path")
    expect(inlineCodeKind(`session/status`)).toBe("path")
  })

  test("detects urls", () => {
    expect(inlineCodeKind(`https://zaovra.com/docs`)).toBe("url")
    expect(inlineCodeKind(`http://localhost:4444`)).toBe("url")
    expect(inlineCodeKind(`file:///tmp/zaovra`)).toBeUndefined()
    expect(inlineCodeKind(`ftp://zaovra.com/docs`)).toBeUndefined()
  })
})
