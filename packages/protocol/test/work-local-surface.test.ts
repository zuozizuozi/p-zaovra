import { describe, expect, test } from "bun:test"
import { WorkGroup } from "../src/groups/work"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"

describe("local WorkGraph protocol surface", () => {
  test("does not publish remote Worker, lease, or controller routes", () => {
    const paths = Object.keys(
      (OpenApi.fromApi(HttpApi.make("work-test").add(WorkGroup)) as { paths: Record<string, unknown> }).paths,
    )

    expect(paths).toContain("/api/work")
    expect(paths).toContain("/api/work/{goalID}/resume")
    expect(paths.some((path) => path.startsWith("/api/work/workers"))).toBe(false)
    expect(paths.some((path) => path.startsWith("/api/work/controllers"))).toBe(false)
    expect(paths.some((path) => path.includes("/jobs/"))).toBe(false)
    expect(paths.some((path) => path.includes("/placement"))).toBe(false)
  })
})
