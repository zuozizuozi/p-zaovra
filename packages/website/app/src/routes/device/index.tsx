import { Meta, Title } from "@solidjs/meta"
import { action, A, createAsync, query, useAction, useNavigate, useSearchParams } from "@solidjs/router"
import { Show, createSignal } from "solid-js"
import { and, Database, eq, gt } from "@zaovra-ai/console-core/drizzle/index.js"
import { Actor } from "@zaovra-ai/console-core/actor.js"
import { AuthStorageTable } from "@zaovra-ai/console-core/schema/auth-storage.sql.js"
import { withActor } from "~/context/auth.withActor"

const deviceStatus = query(async (userCode: string) => {
  "use server"
  return withActor(async () => {
    const actor = Actor.assert("account")
    const row = await Database.use((tx) =>
      tx
        .select({ value: AuthStorageTable.value })
        .from(AuthStorageTable)
        .where(and(eq(AuthStorageTable.key, `desktop-user:${userCode}`), gt(AuthStorageTable.expiry, new Date())))
        .then((rows) => rows[0]),
    )
    return { signedIn: true, accountID: actor.properties.accountID, email: actor.properties.email, found: !!row }
  }).catch(() => ({ signedIn: false, found: false }))
}, "desktop.device.status")

const approve = action(async (userCode: string) => {
  "use server"
  return withActor(async () => {
    const actor = Actor.assert("account")
    const index = await Database.use((tx) =>
      tx
        .select({ value: AuthStorageTable.value })
        .from(AuthStorageTable)
        .where(and(eq(AuthStorageTable.key, `desktop-user:${userCode}`), gt(AuthStorageTable.expiry, new Date())))
        .then((rows) => rows[0]?.value as { deviceCode?: string } | undefined),
    )
    if (!index?.deviceCode) return { ok: false }
    const row = await Database.use((tx) =>
      tx
        .select({ key: AuthStorageTable.key, value: AuthStorageTable.value })
        .from(AuthStorageTable)
        .where(and(eq(AuthStorageTable.key, `desktop-device:${index.deviceCode}`), gt(AuthStorageTable.expiry, new Date())))
        .then((rows) => rows[0]),
    )
    if (!row) return { ok: false }
    const pending = row.value as { status?: string; clientID: string; userCode: string }
    if (pending.status !== "pending" || pending.userCode !== userCode) return { ok: false }
    await Database.use((tx) =>
      tx
        .update(AuthStorageTable)
        .set({
          value: {
            status: "approved",
            accountID: actor.properties.accountID,
            email: actor.properties.email,
            clientID: pending.clientID,
            userCode,
          },
        })
        .where(eq(AuthStorageTable.key, row.key)),
    )
    return { ok: true }
  })
}, "desktop.device.approve")

export default function DeviceApproval() {
  const [search] = useSearchParams<{ user_code?: string }>()
  const navigate = useNavigate()
  const status = createAsync(() => deviceStatus(search.user_code ?? ""))
  const approveDevice = useAction(approve)
  const [done, setDone] = createSignal(false)
  const submit = async () => {
    const result = await approveDevice(search.user_code ?? "")
    if (result.ok) setDone(true)
  }

  return (
    <main style={{ "min-height": "100vh", display: "grid", "place-items": "center", background: "#070b13", color: "#dce7f7", padding: "24px" }}>
      <Title>Authorize Zaovra desktop</Title>
      <Meta name="description" content="Authorize a Zaovra desktop sign-in." />
      <section style={{ width: "min(440px, 100%)", border: "1px solid #273449", padding: "32px", background: "#0b111c" }}>
        <span style={{ color: "#86aee2", "font-size": "12px" }}>ZAOVRA DESKTOP</span>
        <h1 style={{ "font-size": "28px", margin: "18px 0 12px" }}>Authorize this desktop session?</h1>
        <p style={{ color: "#9aabc3", "line-height": "1.7" }}>Code: <strong>{search.user_code ?? "Missing"}</strong></p>
        <Show when={done()} fallback={
          <Show when={status()?.signedIn} fallback={<button onClick={() => navigate(`/login?continue=/device?user_code=${search.user_code ?? ""}`)}>Log in to continue</button>}>
            <button disabled={!status()?.found} onClick={submit}>Authorize desktop</button>
          </Show>
        }>
          <p>You can return to the Zaovra desktop app.</p>
        </Show>
        <p style={{ margin: "20px 0 0", color: "#7789a2", "font-size": "13px" }}>Only approve a code shown by your own Zaovra app.</p>
        <A href="/" style={{ display: "inline-block", margin: "20px 0 0", color: "#a9c2e4" }}>Back to Zaovra</A>
      </section>
    </main>
  )
}
