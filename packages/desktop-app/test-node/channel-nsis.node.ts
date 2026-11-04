import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { statSync } from "node:fs"

// A native NSIS regression fixture, never a product installer. All files and
// protocol keys are newly owned synthetic fixtures; no real Zaovra key is read.
const root = resolve(process.argv[2])
const compiler = resolve(process.argv[3])
const sourceAlias = process.argv[4] ?? process.cwd()
const fixtureAlias = process.argv[5] ?? root
assert.equal(process.platform, "win32")
assert.ok(root.startsWith("F:\\Zaovra-研发记录\\逐次记录\\"))
assert.equal(root.split("\\").at(-1), "nsis-fixture")
await mkdir(root, { recursive: true })
assert.equal(statSync(sourceAlias, { bigint: true }).ino, statSync(process.cwd(), { bigint: true }).ino)
assert.equal(statSync(fixtureAlias, { bigint: true }).ino, statSync(root, { bigint: true }).ino)
const scope = "zaovra-test-584-" + crypto.randomUUID()
const results: unknown[] = []
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )
const reg = (args: string[]) => execFileSync("reg.exe", args, { encoding: "utf8", windowsHide: true, stdio: "pipe" })
const command = (exe: string, args: string[]) =>
  execFileSync(exe, args, { windowsHide: true, stdio: "pipe", timeout: 20_000 })
await writeFile(join(root, "payload.txt"), "SYNTHETIC NSIS FIXTURE; NEVER EXECUTE AS AN APP")
for (const channel of ["dev", "prod", "beta"]) {
  const dir = join(root, channel)
  const exe = channel === "prod" ? "Zaovra.exe" : channel === "dev" ? "Zaovra Dev.exe" : "Zaovra Beta.exe"
  const others = ["Zaovra.exe", "Zaovra Dev.exe", "Zaovra Beta.exe"].filter((name) => name !== exe)
  const scheme = scope + "-" + channel
  const key = "HKCU\\Software\\Classes\\" + scheme
  assert.throws(() => reg(["query", key]))
  const source = `Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include LogicLib.nsh
!define PROJECT_DIR "${process.cwd()}"
!define APP_EXECUTABLE_FILENAME "${exe}"
!define ZAOVRA_SCHEME "${scheme}"
!define ZAOVRA_OTHER_EXE_1 "${others[0]}"
!define ZAOVRA_OTHER_EXE_2 "${others[1]}"
!include "${join(sourceAlias, "resources", "channel-isolation.nsh")}"
OutFile "${join(fixtureAlias, channel + "-setup.exe")}"
InstallDir "${dir}"
Function .onInit
 !insertmacro customInit
FunctionEnd
Function un.onInit
 !insertmacro customUnInit
FunctionEnd
Section
 SetOutPath $INSTDIR
 File "/oname=${exe}" "${join(fixtureAlias, "payload.txt")}"
 WriteRegStr HKCU "Software\\Classes\\${scheme}" "" "Synthetic NSIS regression"
 WriteRegStr HKCU "Software\\Classes\\${scheme}\\shell\\open\\command" "" '"$INSTDIR\\${exe}" "%1"'
 WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd
Section "Uninstall"
 !insertmacro customUnInstall
 Delete "$INSTDIR\\${exe}"
 Delete "$INSTDIR\\Uninstall.exe"
 RMDir "$INSTDIR"
SectionEnd
`
  const script = join(root, channel + ".nsi")
  await writeFile(script, "\ufeff" + source)
  command(compiler, ["-INPUTCHARSET", "UTF8", "/NOCD", "/V2", script])
  command(join(root, channel + "-setup.exe"), ["/S"])
  assert.equal(await exists(join(dir, exe)), true)
  assert.match(reg(["query", key + "\\shell\\open\\command"]), new RegExp(exe.replaceAll(".", "\\.")))
  results.push({ channel, installed: true, directory: dir, scheme })
}
const devBefore = await readFile(join(root, "dev", "Zaovra Dev.exe"))
const prodBefore = await readFile(join(root, "prod", "Zaovra.exe"))
command(join(root, "beta", "Uninstall.exe"), ["/S", "_?=" + join(root, "beta")])
assert.equal(await exists(join(root, "beta", "Zaovra Beta.exe")), false)
assert.deepEqual(await readFile(join(root, "dev", "Zaovra Dev.exe")), devBefore)
assert.deepEqual(await readFile(join(root, "prod", "Zaovra.exe")), prodBefore)
assert.throws(() => reg(["query", "HKCU\\Software\\Classes\\" + scope + "-beta"]))
// A malicious/custom /D target must fail before touching an existing Dev fixture.
assert.throws(() => command(join(root, "beta-setup.exe"), ["/S", "/D=" + join(root, "dev")]))
assert.deepEqual(await readFile(join(root, "dev", "Zaovra Dev.exe")), devBefore)
for (const channel of ["dev", "prod"]) {
  const key = "HKCU\\Software\\Classes\\" + scope + "-" + channel
  const target =
    channel === "dev"
      ? '"F:\\synthetic-newer-install\\Zaovra Dev.exe" "%1"'
      : '"' + join(root, "prod", "Zaovra.exe") + '" -- "%1"'
  reg(["add", key + "\\shell\\open\\command", "/ve", "/t", "REG_SZ", "/d", target, "/f"])
  command(join(root, channel, "Uninstall.exe"), ["/S", "_?=" + join(root, channel)])
  if (channel === "dev") {
    assert.match(reg(["query", key]), /shell/)
    reg(["delete", key, "/f"])
  }
  assert.throws(() => reg(["query", key]))
}
console.log(
  JSON.stringify({
    passed: true,
    results,
    betaUninstallPreservesDevAndProd: true,
    customDirectoryCollisionRejected: true,
    ownedProtocolKeysRemoved: true,
    normalProductInstalled: false,
    normalProtocolReadOrWritten: false,
  }),
)
