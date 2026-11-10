const commands = "BT /F1 18 Tf 40 100 Td (Zaovra 792 artifact) Tj ET"
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`,
]
const serialized = objects.reduce(
  (state, object, index) => ({
    text: state.text + `${index + 1} 0 obj\n${object}\nendobj\n`,
    offsets: [...state.offsets, state.text.length],
  }),
  { text: "%PDF-1.4\n", offsets: [] as number[] },
)
const pdf =
  serialized.text +
  `xref\n0 6\n0000000000 65535 f \n${serialized.offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${serialized.text.length}\n%%EOF\n`

// Scripted provider inputs are executed by the real file tools, never seeded into transcript history.
export const artifactOutputs = [
  {
    path: "成果 报告.html",
    content:
      '<!doctype html><html><head><meta charset="utf-8"><title>792 delivered HTML</title></head><body><h1>792 delivered HTML</h1><img src="diagram.svg" alt="Delivered diagram"><button id="try">Try preview</button><script>document.getElementById("try").onclick=function(){this.textContent="Preview works"}</script></body></html>',
  },
  {
    path: "diagram.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" rx="16" fill="#146b42"/><text x="24" y="68" fill="white" font-size="22">792 actual file</text></svg>',
  },
  { path: "成果 报告.pdf", content: pdf },
]
