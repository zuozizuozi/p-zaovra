export * as PreviewNative from "./preview-native.node"

import { execFile } from "node:child_process"
import path from "node:path"
import { constants } from "node:fs"
import { access, writeFile } from "node:fs/promises"
import { scheduler } from "node:timers/promises"
import { PreviewWindows } from "./preview-windows"

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

function powershell(script: string, directory?: string, env?: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { cwd: directory, env, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())),
    )
  })
}

export async function windowsProcess(pid: number, stop?: string, cancelled?: string) {
  const identity = await powershell(
    `$ErrorActionPreference='Stop'; ${PreviewWindows.script}
$handle=[PreviewNative]::OpenProcess(${0x101000} -bor ${stop ? 1 : 0},$false,${pid})
if($handle -eq [IntPtr]::Zero){exit 0}
$created=Native-Buffer 8; $exited=Native-Buffer 8; $kernel=Native-Buffer 8; $user=Native-Buffer 8
try {
 if([PreviewNative]::WaitForSingleObject($handle,0) -ne 258){exit 0}
 if(![PreviewNative]::GetProcessTimes($handle,$created,$exited,$kernel,$user)){Native-Error}
 $identity=[string][Runtime.InteropServices.Marshal]::ReadInt64($created)
 ${stop ? `if($identity -eq ${quote(stop)}) { ${cancelled ? `try { $marker=[IO.File]::Open(${quote(cancelled)},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read); $marker.Dispose() } catch [IO.IOException] { if(![IO.File]::Exists(${quote(cancelled)})){throw} };` : ""} if(![PreviewNative]::TerminateProcess($handle,143) -or [PreviewNative]::WaitForSingleObject($handle,5000) -ne 0){throw 'Owned preview cancellation did not complete'} }` : ""}
 [Console]::Write($identity)
} finally {
 $null=[PreviewNative]::CloseHandle($handle)
 foreach($buffer in @($created,$exited,$kernel,$user)){[Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)}
}`,
  )
  return identity || undefined
}

export async function launchWindows(line: string, directory: string, env?: NodeJS.ProcessEnv) {
  const output = await powershell(
    `$ErrorActionPreference='Stop'; ${PreviewWindows.script}
[Console]::Write([string](Native-Launch ${quote(line)} ${quote(directory)} $true 0 ''))`,
    directory,
    env,
  )
  const pid = Number(output)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Independent preview supervisor did not return a PID")
  return pid
}

export async function cancelLinux(
  _pid: number,
  expected: string,
  request: string,
  verify: () => Promise<string | undefined>,
  cancelled: string,
) {
  // The owned supervisor compares this to its own boot/start identity, then
  // signals its own group. No Node-side PID lookup/signalling race is possible.
  if ((await verify()) !== expected) return false
  await writeFile(request, expected, {
    mode: 0o600,
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  })
  for (let count = 0; count < 100; count++) {
    if ((await verify()) !== expected)
      return access(cancelled).then(
        () => true,
        () => false,
      )
    await scheduler.wait(20)
  }
  throw new Error("Owned preview supervisor did not acknowledge cancellation")
}
