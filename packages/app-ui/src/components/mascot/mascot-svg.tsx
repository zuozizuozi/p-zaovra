import { HORN, PROMPT_CHEVRON, PROMPT_CURSOR, SHELL, VISOR } from "./geometry"

/**
 * Layered mascot artwork. Every animated layer carries `data-part`; the face layers carry `data-proj` so the
 * rig can re-project them for head turns. Paint servers use per-instance ids so mascots never share defs.
 */
export function MascotSvg(props: { id: string; ref: (svg: SVGSVGElement) => void }) {
  const url = (name: string) => `url(#${props.id}-${name})`
  return (
    <svg
      ref={props.ref}
      viewBox="0 0 256 256"
      style={{ "--zm-body-light": url("body-light"), "--zm-body-dark": url("body-dark") }}
    >
      <defs>
        <radialGradient id={`${props.id}-body-light`} cx=".36" cy=".3" r=".8">
          <stop offset="0" stop-color="#ab90ff" />
          <stop offset=".55" stop-color="#7c58f3" />
          <stop offset="1" stop-color="#5a38d0" />
        </radialGradient>
        <radialGradient id={`${props.id}-body-dark`} cx=".3" cy=".22" r=".95">
          <stop offset="0" stop-color="#7d6bcc" />
          <stop offset=".32" stop-color="#55479a" />
          <stop offset=".68" stop-color="#3a3070" />
          <stop offset="1" stop-color="#2a2256" />
        </radialGradient>
        {/* Edge light without a stroke: transparent centre brightening toward the silhouette. */}
        <radialGradient id={`${props.id}-fresnel`} cx=".5" cy=".55" r=".58">
          <stop offset="0" stop-color="#b6a6ff" stop-opacity="0" />
          <stop offset=".74" stop-color="#b6a6ff" stop-opacity="0" />
          <stop offset=".9" stop-color="#b6a6ff" stop-opacity=".28" />
          <stop offset="1" stop-color="#cfc4ff" stop-opacity=".6" />
        </radialGradient>
        <linearGradient id={`${props.id}-horn`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ "stop-color": "var(--zm-b1)" }} />
          <stop offset="1" style={{ "stop-color": "var(--zm-b3)" }} />
        </linearGradient>
        <radialGradient id={`${props.id}-visor`} cx=".45" cy=".42" r=".62">
          <stop offset="0" stop-color="#0d0a18" />
          <stop offset=".78" stop-color="#120e22" />
          <stop offset="1" stop-color="#231c40" />
        </radialGradient>
        <radialGradient id={`${props.id}-sheen`}>
          <stop offset="0" stop-color="#fff" stop-opacity=".32" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${props.id}-shade`}>
          <stop offset="0" stop-color="#140c33" stop-opacity=".45" />
          <stop offset="1" stop-color="#140c33" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${props.id}-eyeglow`}>
          <stop offset="0" stop-color="#c7a8ff" stop-opacity=".95" />
          <stop offset=".45" stop-color="#a47bff" stop-opacity=".45" />
          <stop offset="1" stop-color="#8b5cf6" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${props.id}-eye`} cx=".42" cy=".38" r=".7">
          <stop offset="0" stop-color="#fff" />
          <stop offset=".6" stop-color="#f3edff" />
          <stop offset="1" stop-color="#dccdff" />
        </radialGradient>
        <linearGradient id={`${props.id}-foot`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ "stop-color": "var(--zm-foot1)" }} />
          <stop offset="1" style={{ "stop-color": "var(--zm-foot2)" }} />
        </linearGradient>
        <radialGradient id={`${props.id}-ground`}>
          <stop offset="0" stop-color="#8b5cf6" />
          <stop offset="1" stop-color="#8b5cf6" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${props.id}-shadow`}>
          <stop offset="0" stop-color="#05030c" />
          <stop offset="1" stop-color="#05030c" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${props.id}-spark`}>
          <stop offset="0" stop-color="#fff" />
          <stop offset=".35" stop-color="#d9c8ff" />
          <stop offset="1" stop-color="#8b5cf6" stop-opacity="0" />
        </radialGradient>
        <linearGradient id={`${props.id}-ring`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#c4b5fd" stop-opacity=".15" />
          <stop offset=".5" stop-color="#c4b5fd" stop-opacity=".9" />
          <stop offset="1" stop-color="#c4b5fd" stop-opacity=".15" />
        </linearGradient>
        <clipPath id={`${props.id}-clip`} clipPathUnits="userSpaceOnUse">
          <path d={SHELL} />
        </clipPath>
      </defs>
      <ellipse data-part="ground" cx="114" cy="217" rx="86" ry="8" fill={url("ground")} />
      <g data-slot="shadow">
        <ellipse data-part="shadow" cx="114" cy="217" rx="76" ry="5.5" fill={url("shadow")} />
      </g>
      <g data-part="rig">
        <g data-badge="processing" data-part="orbit-back" transform="translate(118 148) rotate(-12)">
          <path d="M-98 0 A98 24 0 0 1 98 0" fill="none" stroke={url("ring")} stroke-width="2.4" opacity=".55" />
        </g>
        <ellipse data-part="foot-L" cx="79" cy="205" rx="17" ry="11.3" fill={url("foot")} />
        <ellipse data-part="foot-R" cx="149" cy="205" rx="17" ry="11.3" fill={url("foot")} />
        <g data-part="body">
          <path data-part="antenna" d={HORN} fill={url("horn")} />
          <g data-detail data-slot="halo" fill="none" stroke="#8b5cf6">
            <path d={SHELL} stroke-width="26" opacity=".03" />
            <path d={SHELL} stroke-width="16" opacity=".04" />
            <path d={SHELL} stroke-width="8" opacity=".05" />
          </g>
          <path data-part="shell" d={SHELL} />
          <path data-slot="fresnel" d={SHELL} fill={url("fresnel")} />
          <g clip-path={url("clip")}>
            <ellipse data-detail cx="178" cy="198" rx="70" ry="50" fill={url("shade")} />
            <ellipse
              data-detail
              cx="96"
              cy="70"
              rx="50"
              ry="14"
              transform="rotate(-10 96 70)"
              fill={url("sheen")}
            />
          </g>
          <g data-part="face" clip-path={url("clip")}>
            <path data-part="visor" data-proj d={VISOR} fill={url("visor")} />
            <MascotEye id={props.id} side="L" />
            <MascotEye id={props.id} side="R" />
          </g>
          <g
            data-part="prompt"
            clip-path={url("clip")}
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <g data-detail stroke="#a98bff" stroke-width="10" opacity=".3">
              <path data-proj d={PROMPT_CHEVRON} />
              <path data-proj d={PROMPT_CURSOR} />
            </g>
            <g stroke="#f1eaff" stroke-width="5">
              <path data-proj d={PROMPT_CHEVRON} />
              <path data-proj data-part="cursor" d={PROMPT_CURSOR} />
            </g>
          </g>
        </g>
        <g data-badge="processing" data-part="orbit-front" transform="translate(118 148) rotate(-12)">
          <path d="M98 0 A98 24 0 0 1 -98 0" fill="none" stroke={url("ring")} stroke-width="2.6" />
          <g data-part="spark">
            <circle r="11" fill={url("spark")} opacity=".8" />
            <circle r="4" fill="#fff" />
          </g>
        </g>
      </g>
      <g data-badge="thinking">
        <circle data-part="dot-1" cx="84" cy="38" r="5.5" fill="#8b5cf6" />
        <circle data-part="dot-2" cx="102" cy="38" r="5.5" fill="#8b5cf6" />
        <circle data-part="dot-3" cx="120" cy="38" r="5.5" fill="#8b5cf6" />
      </g>
      <g data-badge="speaking" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path data-part="chev" d="M201 40 L212 50 L201 60" stroke="#8b5cf6" stroke-width="6" />
        <path data-part="under" d="M219 61 H236" stroke="#8b5cf6" stroke-width="6" />
      </g>
      <g data-badge="awaiting">
        <g transform="translate(246 36) scale(.85) translate(-240 -48)">
          <path
            d="M186 48 H226 Q240 48 240 62 V88 Q240 102 226 102 H201 L189 115 L190 102 Q174 100 174 86 V62 Q174 48 186 48 Z"
            fill="#fff"
            stroke="#3b82f6"
            stroke-width="5"
            stroke-linejoin="round"
          />
          <g data-part="qmark">
            <path
              d="M199 66 Q199 57 207 57 Q215 57 215 65 Q215 70 209 73 Q206 75 206 80"
              fill="none"
              stroke="#3b82f6"
              stroke-width="5.5"
              stroke-linecap="round"
            />
            <circle cx="206" cy="90" r="3.6" fill="#3b82f6" />
          </g>
        </g>
      </g>
      <g data-badge="success">
        <g
          transform="translate(246 38) scale(.9) translate(-229 -42)"
          stroke="#8b5cf6"
          stroke-width="7"
          stroke-linecap="round"
        >
          <line data-part="ray-1" x1="192" y1="60" x2="199" y2="42" />
          <line data-part="ray-2" x1="203" y1="78" x2="222" y2="66" />
          <line data-part="ray-3" x1="207" y1="96" x2="229" y2="96" />
        </g>
      </g>
      <g data-badge="error">
        <g transform="translate(246 34) scale(.85) translate(-234 -46)">
          <path d="M205 46 L234 96 H176 Z" fill="#fff" stroke="#f43f5e" stroke-width="6" stroke-linejoin="round" />
          <path d="M205 62 V78" stroke="#f43f5e" stroke-width="6" stroke-linecap="round" />
          <circle cx="205" cy="87.5" r="3.6" fill="#f43f5e" />
          <g stroke="#f43f5e" stroke-width="5.5" stroke-linecap="round">
            <line data-part="err-ray-1" x1="202" y1="114" x2="218" y2="106" />
            <line data-part="err-ray-2" x1="206" y1="130" x2="226" y2="131" />
          </g>
        </g>
      </g>
    </svg>
  )
}

function MascotEye(props: { id: string; side: "L" | "R" }) {
  const eye = `url(#${props.id}-eye)`
  // Asymmetric expressions are drawn for the left eye and mirrored for the right.
  const mirror = props.side === "R" ? "scale(-1 1)" : undefined
  return (
    <g data-part={`eye-${props.side}`}>
      <ellipse data-part="glow" data-detail rx="21" ry="31" fill={`url(#${props.id}-eyeglow)`} />
      <g data-part="shapes">
        <ellipse data-shape="open" rx="10.4" ry="19" fill={eye} />
        <path
          data-shape="closed"
          data-stroke
          d="M-10 -2 Q0 10 10 -2"
          fill="none"
          stroke="#f3edff"
          stroke-width="5"
          stroke-linecap="round"
        />
        <path
          data-shape="happy"
          data-stroke
          d="M-10 5.5 Q0 -10 10 5.5"
          fill="none"
          stroke="#f3edff"
          stroke-width="5"
          stroke-linecap="round"
        />
        <g data-shape="shock" transform={mirror}>
          <ellipse rx="10.5" ry="19.5" fill={eye} />
          <ellipse cx="2.8" cy="1" rx="2.6" ry="10" fill="#1a1330" />
        </g>
        <path
          data-shape="sad"
          transform={mirror}
          d="M-9.4 -4.4 L9.4 -15.4 C11.5 -7.7 11.5 7.7 9.4 12.1 C6 19.2 -6 19.2 -9.4 12.1 C-11.5 6.6 -11.5 0 -9.4 -4.4 Z"
          fill={eye}
        />
      </g>
    </g>
  )
}
