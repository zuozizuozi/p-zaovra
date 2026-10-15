import { useParams } from "@solidjs/router"
import { DocsPage } from "./index"

// Older desktop builds and the retired docs site link to many /docs/* pages; the essentials now live on one page.
export default function DocsPath() {
  const params = useParams()
  return <DocsPage moved={params.path?.replace(/\/$/, "") !== "providers"} />
}
