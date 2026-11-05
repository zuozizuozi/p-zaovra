/** An explicit profile must not replace the normal installation's OS protocol handler. */
export function registerSystemProtocol(input: {
  protocol: string
  explicitProfile: boolean
  onboardingTest: boolean
  register: (protocol: string) => boolean
}) {
  if (input.explicitProfile || input.onboardingTest) return
  return input.register(input.protocol)
}
