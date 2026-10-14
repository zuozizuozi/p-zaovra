import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { gitRemote } from "../../../core/test/fixture/git"
import { Server } from "../../src/server/server"
import { Global } from "@zaovra-ai/core/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Effect } from "effect"
import { pollWithTimeout } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("reference HttpApi", () => {
  test("lists usable references resolved in the server workspace", async () => {
    await using mirror = await tmpdir()
    const origin = await gitRemote(mirror.path)
    await fs.mkdir(path.join(mirror.path, "Effect-TS"))
    await fs.rename(path.join(mirror.path, "origin.git"), path.join(mirror.path, "Effect-TS", "effect.git"))
    const previous = process.env.ZAOVRA_REPO_CLONE_GITHUB_BASE_URL
    process.env.ZAOVRA_REPO_CLONE_GITHUB_BASE_URL = pathToFileURL(mirror.path + path.sep).href
    try {
      await using tmp = await tmpdir({
        config: {
          formatter: false,
          lsp: false,
          references: {
            docs: "./docs",
            effect: { repository: "Effect-TS/effect", branch: "main" },
            bad: "not-a-repo",
          },
        },
      })

      const body = await Effect.runPromise(
        pollWithTimeout(
          Effect.promise(async () => {
            const response = await Server.Default().app.request("/api/reference", {
              headers: { "x-zaovra-directory": encodeURIComponent(tmp.path) },
            })
            expect(response.status).toBe(200)
            const body = await response.json()
            const cloned = Bun.file(path.join(Global.Path.repos, "github.com", "Effect-TS", "effect", "README.md"))
            if (!(await cloned.exists())) return undefined
            expect((await cloned.text()).replaceAll("\r\n", "\n")).toBe(
              (await Bun.file(path.join(origin.source, "README.md")).text()).replaceAll("\r\n", "\n"),
            )
            return body.data.length === 0 ? undefined : body
          }),
          "references were not loaded",
        ),
      )
      expect(body).toMatchObject({ location: { directory: tmp.path } })
      expect(body.data).toEqual([
        {
          name: "docs",
          path: path.join(tmp.path, "docs"),
          source: {
            type: "local",
            path: path.join(tmp.path, "docs"),
          },
        },
        {
          name: "effect",
          path: path.join(Global.Path.repos, "github.com", "Effect-TS", "effect"),
          source: {
            type: "git",
            repository: "Effect-TS/effect",
            branch: "main",
          },
        },
      ])
    } finally {
      if (previous === undefined) delete process.env.ZAOVRA_REPO_CLONE_GITHUB_BASE_URL
      else process.env.ZAOVRA_REPO_CLONE_GITHUB_BASE_URL = previous
    }
  }, 30_000)
})
