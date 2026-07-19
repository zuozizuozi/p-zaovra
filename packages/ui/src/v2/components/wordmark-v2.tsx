import { type ComponentProps } from "solid-js"
import brandLogo from "../../assets/brand/zaovra-logo.png"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 560 128"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
      role="img"
      aria-label="Zaovra"
    >
      <image href={brandLogo} width="112" height="112" y="8" />
      <text
        x="140"
        y="91"
        fill="currentColor"
        font-family="Inter, Segoe UI, sans-serif"
        font-size="74"
        font-weight="700"
        letter-spacing="-3"
      >
        zaovra
      </text>
    </svg>
  )
}
