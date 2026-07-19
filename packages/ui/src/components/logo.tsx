import { type ComponentProps } from "solid-js"
import brandLogo from "../assets/brand/zaovra-logo.png"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href={brandLogo} width="512" height="512" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href={brandLogo} width="512" height="512" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 560 128"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <image href={brandLogo} width="112" height="112" y="8" />
      <text
        x="140"
        y="91"
        fill="var(--icon-strong-base)"
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
