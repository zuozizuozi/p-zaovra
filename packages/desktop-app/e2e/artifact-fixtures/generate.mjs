import { readFile, writeFile } from "node:fs/promises"
import { deflateSync } from "node:zlib"
function chunk(type, value) {
  const bytes = Buffer.concat([Buffer.from(type), value])
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4)
  length.writeUInt32BE(value.length)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, bytes, checksum])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(64, 0)
header.writeUInt32BE(48, 4)
header[8] = 8
header[9] = 2
const pixels = Buffer.alloc(48 * (64 * 3 + 1))
for (let y = 0; y < 48; y++)
  for (let x = 0; x < 64; x++) {
    const offset = y * 193 + 1 + x * 3
    pixels[offset] = x < 32 ? 230 : 30
    pixels[offset + 1] = y < 24 ? 60 : 180
    pixels[offset + 2] = 120
  }
await writeFile(
  "proof.png.candidate",
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
)
await writeFile("proof.pdf.candidate", await readFile("fixture.pdf"))
await writeFile(
  "proof.svg.candidate",
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#163b6c"/><text x="20" y="90" fill="white" font-size="24">ARTIFACT SVG</text></svg>',
)
console.log("Generated proof.pdf.candidate, proof.png.candidate, proof.svg.candidate")
