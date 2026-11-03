/** Capture only the invoking app WebContents, never the screen or another app. */
export async function captureFeedbackScreenshot(
  capture: () => Promise<{
    getSize(): { width: number; height: number }
    toPNG(): Buffer
    toDataURL(): string
  }>,
) {
  const image = await capture()
  const size = image.getSize()
  if (size.width <= 0 || size.height <= 0 || size.width * size.height > 8_000_000)
    throw new Error("Screenshot is empty or too large")
  if (image.toPNG().byteLength > 3_000_000) throw new Error("Screenshot is too large")
  const data = image.toDataURL()
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 4_000_000)
    throw new Error("Invalid screenshot")
  return data
}
