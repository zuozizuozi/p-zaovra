import path from "node:path"
import fs from "node:fs/promises"

// A harmless executable: every invocation leaves evidence, including --version.
export async function probeShell(directory: string, version = "1.0.0", name = "probe") {
  const marker = path.join(directory, "probe-marker")
  const executable = path.join(directory, process.platform === "win32" ? `${name}.exe` : name)
  if (process.platform === "win32") {
    const source = path.join(directory, "probe.cs")
    await Bun.write(
      source,
      `class Probe { static void Main() { System.IO.File.WriteAllText(@"${marker.replaceAll('"', '""')}", "ran"); System.Console.WriteLine("${version}"); } }`,
    )
    const result = Bun.spawnSync([
      path.join(process.env.SystemRoot ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
      "/nologo",
      `/out:${executable}`,
      source,
    ])
    if (result.exitCode !== 0) throw new Error(result.stdout.toString() + result.stderr.toString())
    return { executable, marker }
  }
  await Bun.write(executable, `#!/bin/sh\nprintf ran > '${marker.replaceAll("'", "'\\''")}'\nprintf '1.0.0\\n'\n`)
  await fs.chmod(executable, 0o755)
  return { executable, marker }
}
