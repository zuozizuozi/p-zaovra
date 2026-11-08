import { render } from "solid-js/web"
import { ToolErrorCard } from "../src/components/tool-error-card"
import "../../ui/src/styles/index.css"
import "../src/styles/index.css"

const longTarget = "missing-" + "very-long-segment-".repeat(12) + ".txt"
const cases = [
  {
    id: "short",
    tool: "read",
    title: "读取",
    subtitle: "文件不存在，请检查路径。",
    error: "File not found: short.txt",
  },
  { id: "long-en", tool: "read", error: "File not found: /workspace/" + longTarget },
  {
    id: "long-zh",
    tool: "read",
    title: "读取",
    subtitle:
      "文件不存在，请检查文件路径是否正确，然后重新读取。这是一段需要多行完整显示的错误说明，用来确认折叠摘要不会被固定高度裁切。",
    error: "File not found: /workspace/中文测试文件.txt",
  },
  {
    id: "link",
    tool: "task",
    title: "任务",
    subtitle: "Subagent " + longTarget,
    href: "#task-details",
    error: "Subagent failed: " + longTarget,
  },
]

render(
  () => (
    <main style={{ padding: "24px", "box-sizing": "border-box", width: "100%" }}>
      {cases.map((item) => (
        <section data-case={item.id} data-error={item.error} style={{ "margin-bottom": "12px" }}>
          <ToolErrorCard {...item} />
        </section>
      ))}
    </main>
  ),
  document.getElementById("root")!,
)
