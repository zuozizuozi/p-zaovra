import { test } from "@playwright/test"
import { verifyReading790, verifyPrepend790 } from "./ownership790-browser"

test("790 backward measured reflow, keyboard reading and explicit latest", async ({ page }) => {
  await verifyReading790(page)
})
test("790 rapid genuine prepend preserves the row before its DOM mounts", async ({ page }) => {
  await verifyPrepend790(page)
})
