import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js"
import path from "node:path"

if (process.platform === "win32") {
  const root = path.resolve(import.meta.dir, "..")
  const bytes = process.env.ZAOVRA_RG_ARCHIVE
    ? await Bun.file(process.env.ZAOVRA_RG_ARCHIVE).arrayBuffer()
    : await fetch(
        "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
      ).then((response) => {
        if (!response.ok) throw new Error(`ripgrep download failed: ${response.status}`)
        return response.arrayBuffer()
      })
  // Pin the upstream archive, including locally supplied build inputs.
  if (
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !==
    "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a"
  )
    throw new Error("ripgrep archive checksum mismatch")
  const archive = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)))
  const entries = await archive.getEntries()
  for (const name of ["rg.exe", "COPYING", "LICENSE-MIT", "UNLICENSE"]) {
    const entry = entries.find((entry) => entry.filename.endsWith(`/${name}`))
    if (!entry || entry.directory) throw new Error(`ripgrep archive missing ${name}`)
    await Bun.write(
      path.join(root, name === "rg.exe" ? "resources/bin/rg.exe" : `resources/licenses/ripgrep-${name}.txt`),
      await entry.getData(new Uint8ArrayWriter()),
    )
  }
  await archive.close()
}
