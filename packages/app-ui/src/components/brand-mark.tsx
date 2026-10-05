import mascot from "@/assets/zaovra-idle-128.webp"
import mascot2x from "@/assets/zaovra-idle-256.webp"

export function BrandMark(props: { class?: string }) {
  return (
    <img
      data-component="brand-mark"
      src={mascot}
      srcset={`${mascot} 1x, ${mascot2x} 2x`}
      class={props.class}
      alt=""
      aria-hidden="true"
    />
  )
}
