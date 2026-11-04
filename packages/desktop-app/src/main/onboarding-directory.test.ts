import { expect, test } from "bun:test"
import { completeFirstLaunch } from "./onboarding-directory"

test("first launch asks for a location and stays pending without automatic writes", async () => {
  let completed = false
  expect(
    await completeFirstLaunch({
      pending: true,
      create: true,
      complete: () => {
        completed = true
      },
    }),
  ).toEqual({ needsDirectory: true })
  expect(completed).toBe(false)
})

test("explicit skip or selected location completes onboarding; restart is a no-op", async () => {
  let pending = true
  const complete = () => {
    pending = false
  }
  expect(await completeFirstLaunch({ pending, create: false, complete })).toBe(null)
  expect(pending).toBe(false)
  expect(await completeFirstLaunch({ pending, create: true, complete })).toBe(null)
})

test("completion storage errors remain visible without a second project directory", async () => {
  await expect(
    completeFirstLaunch({
      pending: true,
      create: false,
      complete: () => {
        throw new Error("store unavailable")
      },
    }),
  ).rejects.toThrow("store unavailable")
})
