# Realtime reply regression

Run from `packages/desktop-app` against an unpacked build containing the renderer under test:

```sh
node e2e/realtime-reply.mjs <executable> <fresh-evidence-directory>
```

The test uses a fresh isolated profile and a loopback Chat provider with a synthetic credential. It saves the service through the UI, holds each reply stream open until text is visible, checks a second request in the same session, then checks a new session using the saved service. Each reply must become visible within 30 seconds without reloading. The returned `mp-returned` model footer must have visible geometry and opaque ancestors while the mouse is away.

Screenshots and timing reports stay in the evidence directory. The app and provider close in `finally`. This checks realtime replies; it does not certify installer launch, upgrades, the other main-path steps, or a release gate.
