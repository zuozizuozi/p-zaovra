export function createRelaunchHandler(input: {
  stop: () => Promise<void>
  relaunch: () => void
  quitting: (value: boolean) => void
  failed: (error: unknown) => void
}) {
  let pending: Promise<void> | undefined
  return () => {
    if (pending) return pending
    input.quitting(true)
    pending = Promise.resolve()
      .then(input.stop)
      .then(input.relaunch)
      .catch((error) => {
        pending = undefined
        input.quitting(false)
        input.failed(error)
      })
    return pending
  }
}
