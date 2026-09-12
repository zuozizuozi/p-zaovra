export function createQuitHandler(input: {
  stop: () => Promise<void>
  quit: () => void
  failed: (error: unknown) => void
}) {
  let ready = false
  let pending: Promise<void> | undefined
  return (event: { preventDefault(): void }) => {
    if (ready) return
    event.preventDefault()
    if (pending) return
    pending = Promise.resolve()
      .then(input.stop)
      .then(() => {
        ready = true
        input.quit()
      })
      .catch((error) => {
        pending = undefined
        input.failed(error)
      })
  }
}
