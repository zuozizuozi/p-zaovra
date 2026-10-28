import { type ComponentProps } from "solid-js"
import brandLogo from "../assets/brand/zaovra-mascot.png"
import lockupLight from "../assets/brand/zaovra-lockup-light.png"
import lockupDark from "../assets/brand/zaovra-lockup-dark.png"
import "./logo.css"

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
    <span data-component="logo-lockup" class={props.class}>
      <img data-variant="light" src={lockupLight} alt="Zaovra" />
      <img data-variant="dark" src={lockupDark} alt="Zaovra" />
    </span>
  )
}

/** English lettering from the approved lockup, without its mascot. */
export const Wordmark = (props: { class?: string }) => (
  <span data-component="logo-wordmark" class={props.class} role="img" aria-label="Zaovra">
    <svg data-variant="light" viewBox="600 180 1420 215" aria-hidden="true">
      <image href={lockupLight} width="2035" height="518" />
    </svg>
    <svg data-variant="dark" viewBox="600 180 1420 215" aria-hidden="true">
      <image href={lockupDark} width="2035" height="518" />
    </svg>
  </span>
)
