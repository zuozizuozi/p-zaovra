import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { inflateSync } from "node:zlib"
const pdf = await readFile("proof.pdf.candidate")
assert(pdf.equals(await readFile("fixture.pdf")) && pdf.subarray(0, 5).toString() === "%PDF-")
assert(pdf.toString("latin1").includes("%%EOF"))
const png = await readFile("proof.png.candidate")
assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
assert.equal(png.readUInt32BE(16), 64)
assert.equal(png.readUInt32BE(20), 48)
const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))
assert.equal(raw.length, 48 * 193)
assert.equal(raw[1], 230)
assert.equal(raw[1 + 33 * 3], 30)
const svg = await readFile("proof.svg.candidate", "utf8")
assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith("</svg>"))
assert(svg.includes('width="320" height="180"') && svg.includes("ARTIFACT SVG"))
console.log(
  "PASS PDF fixture identity/header/EOF; PNG decoded 64x48 pixels; SVG declared dimensions/content. Visual previews require separate UI acceptance.",
)
