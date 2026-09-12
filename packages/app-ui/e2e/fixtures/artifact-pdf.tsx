import { render } from "solid-js/web"
import ArtifactPDF from "../../src/components/artifact-pdf"
import "../../src/index.css"
render(() => <ArtifactPDF load={() => fetch("./artifact-scan.pdf").then((response) => response.arrayBuffer())} />, document.getElementById("pdf-test")!)
