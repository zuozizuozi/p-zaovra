import { EYES, HEAD, PIVOT } from "./geometry"

export type MascotPose = "idle" | "thinking" | "processing" | "speaking" | "awaiting" | "success" | "error"
type Expression = "open" | "closed" | "happy" | "shock" | "sad"
type Spring = { x: number; v: number }
type Frame = {
  tx: number
  ty: number
  jy: number
  rot: number
  sx: number
  sy: number
  eyeS: number
  eyeY: number
  closure: number
  badgeRot: Partial<Record<MascotPose, number>>
}
type Action = { t0: number; dur: number; apply: (p: number, frame: Frame) => void; mid?: () => void; midAt: number }

const EXPRESSION: Record<MascotPose, Expression> = {
  idle: "open",
  thinking: "happy",
  processing: "closed",
  speaking: "open",
  awaiting: "open",
  success: "happy",
  error: "shock",
}
const BADGES: Record<Exclude<MascotPose, "idle">, { pivot?: readonly [number, number]; delay: number }> = {
  thinking: { pivot: [102, 46], delay: 0.1 },
  processing: { delay: 0.05 },
  speaking: { pivot: [204, 62], delay: 0.1 },
  awaiting: { pivot: [203, 97], delay: 0.05 },
  success: { pivot: [216, 78], delay: 0.32 },
  error: { pivot: [221, 79], delay: 0.08 },
}
// Breathing period (s) and amplitude per pose; poses not listed breathe at the idle rate.
const BREATH: Partial<Record<MascotPose, readonly [number, number]>> = {
  error: [4.4, 0.012],
  thinking: [2.8, 0.02],
  speaking: [2.2, 0.016],
  processing: [2.6, 0.018],
}
const BADGE_KEYS = Object.keys(BADGES) as (keyof typeof BADGES)[]
const EASE = {
  inOut: (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2),
  out: (p: number) => 1 - (1 - p) ** 3,
  in: (p: number) => p * p * p,
}
type Key = readonly [number, number, (keyof typeof EASE)?]

/**
 * Drives one mascot SVG: breathing, blinks, a pseudo-3D head turn toward the pointer, state entrances,
 * secondary motion and status badges. Rendering is plain attribute writes on a shared animation frame.
 */
export function createMascotRig(svg: SVGSVGElement) {
  // Shared parts are looked up once; per-eye parts are resolved from each eye root below.
  const parts = new Map([...svg.querySelectorAll<SVGElement>("[data-part]")].map((node) => [node.dataset.part!, node]))
  const part = <T extends Element = SVGGraphicsElement>(name: string) => parts.get(name) as unknown as T
  const badgeEls = Object.fromEntries(
    BADGE_KEYS.map((key) => [key, [...svg.querySelectorAll<SVGGElement>(`[data-badge="${key}"]`)]]),
  ) as Record<keyof typeof BADGES, SVGGElement[]>
  const eyes = [part("eye-L"), part("eye-R")].map((root) => ({
    root,
    shapes: root.querySelector<SVGGElement>('[data-part="shapes"]')!,
    glow: root.querySelector<SVGEllipseElement>('[data-part="glow"]')!,
    list: [...root.querySelectorAll<SVGElement>("[data-shape]")],
  }))
  const projected = [...svg.querySelectorAll<SVGPathElement>("[data-proj]")].map((node) => ({
    node,
    d: node.getAttribute("d")!,
    nums: node.getAttribute("d")!.match(/-?[\d.]+/g)!.map(Number),
  }))
  const motion = {
    pose: "idle" as MascotPose,
    expression: "open" as Expression,
    shown: "",
    projectedPose: "",
    still: true,
    enteredAt: 0,
    nextBlink: 1 + Math.random() * 2,
    nextGesture: 5,
    seed: Math.random(),
    wander: { x: 0, y: 0, next: 0 },
    last: { x: 0, y: 0 },
    prevJy: 0,
    actions: [] as Action[],
  }
  const eye = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 } }
  const head = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 } }
  const fin = { x: 0, v: 0 }
  const badge = Object.fromEntries(BADGE_KEYS.map((key) => [key, { x: 0, v: 0 }])) as Record<
    keyof typeof BADGES,
    Spring
  >

  const play = (dur: number, apply: Action["apply"], extra: { delay?: number; mid?: () => void; midAt?: number } = {}) =>
    motion.actions.push({ t0: clock.t + (extra.delay ?? 0), dur, apply, mid: extra.mid, midAt: extra.midAt ?? 0.5 })
  // Squash the eye, show the closed ‿ shape at full closure, reopen; expression swaps happen unseen at mid.
  const blink = (mid?: () => void, delay = 0) =>
    play(
      0.24,
      (p, f) => (f.closure = Math.max(f.closure, kf(p, [[0, 0], [0.35, 1, "in"], [0.6, 1], [1, 0, "out"]]))),
      { mid, midAt: 0.48, delay },
    )
  const jump = (h: number, dur: number) =>
    play(dur, (p, f) => {
      f.sy *= kf(p, [[0, 1], [0.2, 0.8, "out"], [0.3, 1.12, "out"], [0.5, 1], [0.62, 1.03], [0.7, 0.84, "out"], [0.83, 1.05], [1, 1]])
      f.sx *= kf(p, [[0, 1], [0.2, 1.14, "out"], [0.3, 0.9, "out"], [0.5, 1], [0.62, 0.98], [0.7, 1.12, "out"], [0.83, 0.97], [1, 1]])
      f.jy += kf(p, [[0, 0], [0.22, 0], [0.45, -h, "out"], [0.65, 0, "in"], [1, 0]])
      f.eyeS *= kf(p, [[0, 1], [0.2, 0.85], [0.3, 1.05], [0.65, 1], [0.7, 0.75], [0.85, 1]])
    })
  const hmm = () =>
    play(0.9, (p, f) => {
      f.rot += kf(p, [[0, 0], [0.4, -4], [1, 0]])
      f.sy *= kf(p, [[0, 1], [0.4, 1.03], [1, 1]])
    })
  const nod = () => play(0.5, (p, f) => (f.sy *= kf(p, [[0, 1], [0.35, 0.93, "out"], [0.7, 1.02], [1, 1]])))
  const gestures: Partial<Record<MascotPose, (() => void)[]>> = {
    idle: [
      () =>
        play(1.4, (p, f) => {
          f.sy *= kf(p, [[0, 1], [0.45, 1.07], [0.75, 0.96], [1, 1]])
          f.sx *= kf(p, [[0, 1], [0.45, 0.96], [0.75, 1.03], [1, 1]])
          f.eyeS *= kf(p, [[0, 1], [0.3, 0.55], [0.6, 0.55], [0.8, 1]])
        }),
      () => jump(6, 0.55),
      () => blink(),
    ],
    awaiting: [() => jump(7, 0.6)],
    success: [() => jump(9, 0.65)],
    thinking: [hmm],
    error: [
      () =>
        play(1.8, (p, f) => {
          f.sy *= kf(p, [[0, 1], [0.3, 1.025], [0.7, 0.95], [1, 1]])
          f.eyeY += kf(p, [[0, 0], [0.6, 3], [1, 0]])
        }),
    ],
  }

  function setPose(pose: MascotPose) {
    if (pose === motion.pose && motion.enteredAt) return
    Object.assign(motion, { pose, enteredAt: clock.t || 1e-6, nextGesture: clock.t + 4 + Math.random() * 3, actions: [] })
    const expression = EXPRESSION[pose]
    if (motion.still) {
      motion.expression = pose === "error" ? "sad" : expression
      return update(clock.t, 0)
    }
    if (expression !== motion.expression) blink(() => (motion.expression = expression))
    if (pose === "success") jump(22, 0.95)
    if (pose === "awaiting") jump(7, 0.6)
    if (pose === "thinking") hmm()
    if (pose === "speaking" || pose === "processing") nod()
    if (pose !== "error") return
    play(0.9, (p, f) => {
      f.sx *= kf(p, [[0, 1], [0.12, 0.86, "out"], [0.35, 1.02], [0.6, 0.98], [1, 1]])
      f.sy *= kf(p, [[0, 1], [0.12, 0.9, "out"], [0.35, 1.01], [1, 1]])
      f.tx += kf(p, [[0, 0], [0.12, 6, "out"], [1, 0]]) + (p > 0.1 ? 2.2 * Math.sin(p * 50) * (1 - p) : 0)
      f.rot += kf(p, [[0, 0], [0.12, 5, "out"], [1, 0]])
    })
    play(0.7, (p, f) => (f.badgeRot.error = 12 * Math.sin(p * Math.PI * 5) * (1 - p)), { delay: 0.1 })
    blink(() => motion.pose === "error" && (motion.expression = "sad"), 1.6)
  }

  function poke() {
    if (motion.still) return
    play(0.5, (p, f) => {
      f.sy *= kf(p, [[0, 1], [0.2, 0.86, "out"], [0.5, 1.06], [0.75, 0.98], [1, 1]])
      f.sx *= kf(p, [[0, 1], [0.2, 1.1, "out"], [0.5, 0.96], [0.75, 1.01], [1, 1]])
    })
    if (motion.pose === "error") return blink()
    const back = motion.expression
    blink(() => (motion.expression = "happy"))
    play(0.9, () => undefined, {
      mid: () => back !== "happy" && motion.expression === "happy" && blink(() => (motion.expression = back)),
      midAt: 1,
    })
  }

  function lookAt(x: number, y: number) {
    const rect = svg.getBoundingClientRect()
    const dx = x - (rect.left + rect.width * 0.37)
    const dy = y - (rect.top + rect.height * 0.55)
    const d = Math.hypot(dx, dy)
    return { x: (dx / (d + 160)) * 1.3, y: (dy / (d + 160)) * 1.3 }
  }

  function gazeTarget(t: number, ts: number) {
    const mouse = pointer.seen && t - pointer.t < 2.5
    const user = () => (mouse ? lookAt(pointer.x, pointer.y) : { x: -0.1, y: 0 })
    const pose = motion.pose
    if (pose === "idle") {
      if (mouse) return lookAt(pointer.x, pointer.y)
      if (t > motion.wander.next) {
        const angle = Math.random() * Math.PI * 2
        const r = Math.random() < 0.35 ? 0 : 0.4 + Math.random() * 0.5
        motion.wander = { x: Math.cos(angle) * r, y: Math.sin(angle) * r * 0.7, next: t + 0.8 + Math.random() * 1.8 }
      }
      return motion.wander
    }
    if (pose === "thinking") return [{ x: 0.5, y: -0.85 }, { x: -0.3, y: -0.8 }, { x: 0.1, y: -0.95 }][Math.floor(ts / 2.4) % 3]
    if (pose === "processing") return { x: 0.25 * Math.sin(ts * 0.9), y: 0.15 }
    if (pose === "speaking") {
      // Read the output below line by line.
      const line = Math.floor(ts / 1.3) % 4
      const p = (ts % 1.3) / 1.3
      return { x: p < 0.85 ? -0.5 + 1.1 * (p / 0.85) : -0.5, y: 0.3 + line * 0.12 }
    }
    if (pose === "awaiting") return ts % 3.6 < 1.2 ? { x: 0.85, y: -0.6 } : user()
    if (pose === "success") {
      const g = user()
      return { x: g.x * 0.5, y: g.y * 0.5 - 0.1 }
    }
    if (ts < 1.6) return user()
    return { x: -0.2 + 0.15 * Math.sin(ts * 0.5), y: 0.55 }
  }

  function update(t: number, dt: number) {
    const still = motion.still
    const pose = motion.pose
    const ts = t - motion.enteredAt
    const f: Frame = { tx: 0, ty: 0, jy: 0, rot: 0, sx: 1, sy: 1, eyeS: 1, eyeY: 0, closure: 0, badgeRot: {} }
    const osc = (period: number, phase = 0) => (still ? 0 : Math.sin((t / period + phase) * Math.PI * 2))

    const g = still ? restingGaze(pose) : gazeTarget(t, ts)
    const len = Math.hypot(g.x, g.y)
    const target = len > 1 ? { x: g.x / len, y: g.y / len } : { x: g.x, y: g.y }
    if (!still && Math.hypot(target.x - motion.last.x, target.y - motion.last.y) > 0.9 && Math.random() < 0.5 && pose !== "success")
      blink()
    motion.last = target
    for (const k of ["x", "y"] as const) {
      if (still) {
        eye[k] = { x: target[k], v: 0 }
        head[k] = { x: target[k], v: 0 }
        continue
      }
      spring(eye[k], target[k], 30, 1, dt)
      spring(head[k], target[k], 6.5, 1, dt)
    }

    if (!still && t > motion.nextBlink) {
      motion.nextBlink = t + 2 + Math.random() * 4
      blink()
      if (Math.random() < 0.15) blink(undefined, 0.3)
    }
    if (!still && t > motion.nextGesture) {
      motion.nextGesture = t + 4 + Math.random() * 4
      const list = gestures[pose]
      if (list) list[Math.floor(Math.random() * list.length)]()
    }

    const breath = BREATH[pose] ?? [3.4, 0.02]
    const b = osc(breath[0], motion.seed)
    f.sy *= 1 + breath[1] * b
    f.sx *= 1 - breath[1] * 0.45 * b
    f.rot += head.x.x * 2
    if (pose === "idle") f.rot += osc(6.1, motion.seed)
    if (pose === "thinking") f.rot += osc(2.6) * 2.6
    if (pose === "processing") {
      f.rot += osc(1.8, 0.25) * 1.6
      f.ty -= Math.abs(osc(1.8)) * 1.2
    }
    if (pose === "speaking") {
      const bob = Math.abs(osc(0.9))
      f.ty -= bob * 1.6
      f.sy *= 1 + 0.012 * bob
      f.eyeS *= 0.9
    }
    if (pose === "awaiting") {
      f.rot += -4 + osc(3.2) * 3
      f.eyeS *= 1.05
    }
    if (pose === "success") f.ty -= Math.abs(osc(1.1)) * 1.2
    if (pose === "error") {
      f.sx *= 0.97
      f.sy *= 0.96
      f.rot += 1.5
      if (ts < 1.6) f.tx += osc(0.11) * 0.5
    }

    motion.actions = motion.actions.filter((action) => {
      if (still) return false
      const p = (t - action.t0) / action.dur
      if (p < 0) return true
      if (action.mid && p >= action.midAt) {
        const mid = action.mid
        action.mid = undefined
        mid()
      }
      action.apply(Math.min(1, p), f)
      return p < 1
    })

    // Secondary motion: the horn lags the body and flops on take-off and landing.
    const jv = dt > 0 ? (f.jy - motion.prevJy) / dt : 0
    motion.prevJy = f.jy
    const finTarget = f.rot * 0.9 + clamp(jv * 0.12, -22, 22) + osc(2.7, motion.seed) * 1.5
    if (still) Object.assign(fin, { x: finTarget, v: 0 })
    if (!still) spring(fin, finTarget, 14, 0.28, dt)

    for (const key of BADGE_KEYS) {
      const on = pose === key && (still || ts >= BADGES[key].delay) ? 1 : 0
      if (still) Object.assign(badge[key], { x: on, v: 0 })
      if (!still) spring(badge[key], on, 16, 0.42, dt)
    }
    render(ts, f, osc)
  }

  function render(ts: number, f: Frame, osc: (period: number, phase?: number) => number) {
    const hx = head.x.x
    const hy = head.y.x
    tf(part("rig"), `translate(0 ${f.jy})`)
    tf(
      part("body"),
      `translate(${PIVOT[0] + f.tx} ${PIVOT[1] + f.ty}) rotate(${f.rot}) scale(${f.sx} ${f.sy}) translate(${-PIVOT[0]} ${-PIVOT[1]})`,
    )
    const yaw = HEAD.neutral + hx * (hx > 0 ? HEAD.right : HEAD.left)
    const pitch = hy * HEAD.pitch
    // The horn sits on the back of the head, so it slides the opposite way.
    tf(
      part("antenna"),
      `translate(${-(Math.sin(yaw) - Math.sin(HEAD.neutral)) * 16} ${Math.sin(pitch) * 4}) rotate(${fin.x} 150 84)`,
    )
    // >_ sits on the side; fade it as it rotates toward the silhouette instead of leaving a sliver.
    part<SVGGElement>("prompt").style.opacity = String(clamp((project(196, 155, yaw, pitch).z - 0.12) / 0.18, 0, 1))
    const key = `${yaw.toFixed(4)} ${pitch.toFixed(4)}`
    if (key !== motion.projectedPose) {
      motion.projectedPose = key
      projected.forEach((item) => {
        const out = item.nums.flatMap((value, i) => {
          if (i % 2) return []
          const q = project(value, item.nums[i + 1], yaw, pitch)
          return [q.x.toFixed(1), q.y.toFixed(1)]
        })
        let i = 0
        item.node.setAttribute("d", item.d.replace(/-?[\d.]+/g, () => out[i++]))
      })
    }

    // The closed ‿ replaces the squashed eye at full closure.
    const shape = f.closure > 0.7 && motion.expression !== "closed" ? "closed" : motion.expression
    if (shape !== motion.shown) {
      motion.shown = shape
      eyes.forEach((e) => e.list.forEach((node) => (node.style.display = node.dataset.shape === shape ? "" : "none")))
    }
    const squash = shape === "closed" ? 1 : 1 - Math.min(f.closure, 0.7) * 1.25
    const round = shape === "open" || shape === "shock"
    // Head turn carries the eyes; a small fast offset on top keeps the saccade feel.
    const gx = (eye.x.x - hx) * 4
    const gy = (eye.y.x - hy) * 3 + f.eyeY
    eyes.forEach((e, i) => {
      const q = project(EYES[i][0], EYES[i][1], yaw, pitch)
      tf(e.root, `translate(${q.x + gx} ${q.y + gy}) scale(${q.sx} ${q.sy})`)
      tf(e.shapes, `scale(1 ${Math.max(0.08, f.eyeS * squash)})`)
      tf(e.glow, `scale(${round ? 1 : 0.8} ${Math.max(0.3, (round ? 1 : 0.55) * f.eyeS * squash)})`)
    })
    part<SVGPathElement>("cursor").style.opacity = motion.pose !== "speaking" || osc(1.06) > -0.2 ? "1" : "0.2"
    const lift = clamp(-f.jy / 50, 0, 0.6)
    tf(part("shadow"), `translate(114 217) scale(${(1 - lift) * f.sx} 1) translate(-114 -217)`)
    part("shadow").setAttribute("opacity", (1 - lift).toFixed(3))
    tf(part("ground"), `translate(114 217) scale(${1 - lift * 0.5} 1) translate(-114 -217)`)

    for (const name of BADGE_KEYS) {
      const value = badge[name].x
      const hidden = value < 0.01 && badge[name].v <= 0
      badgeEls[name].forEach((node) => {
        node.style.display = hidden ? "none" : ""
        node.style.opacity = String(clamp(value * 1.6, 0, 1))
      })
      const pivot = BADGES[name].pivot
      if (hidden || !pivot) continue
      const float = name === "awaiting" ? osc(2.2) * 2 : name === "thinking" ? 0 : osc(2.6)
      tf(
        badgeEls[name][0],
        `translate(${pivot[0]} ${pivot[1] + float}) rotate(${f.badgeRot[name] ?? 0}) scale(${Math.max(0, value)}) translate(${-pivot[0]} ${-pivot[1]})`,
      )
    }
    const visible = (name: keyof typeof BADGES) => badgeEls[name][0].style.display !== "none"
    if (visible("thinking"))
      [1, 2, 3].forEach((i) => {
        const w = Math.max(0, osc(1.3, -i * 0.14))
        tf(part(`dot-${i}`), `translate(0 ${-w * 6})`)
        part(`dot-${i}`).setAttribute("fill", w > 0.6 ? "#e6dcff" : "#8b5cf6")
      })
    if (visible("processing")) {
      // The spark travels the ring and is in front of the body only on the lower half.
      const a = (motion.still ? 0.35 : ts / 1.7) * Math.PI * 2 + Math.PI
      const parent = part(Math.sin(a) > 0 ? "orbit-front" : "orbit-back")
      const spark = part("spark")
      if (spark.parentNode !== parent) parent.appendChild(spark)
      tf(spark, `translate(${98 * Math.cos(a)} ${24 * Math.sin(a)}) scale(${0.75 + 0.35 * Math.sin(a)})`)
      for (const name of ["orbit-front", "orbit-back"])
        tf(part(name), `translate(118 148) rotate(${-12 + osc(3.4) * 3}) scale(${Math.max(0, badge.processing.x)})`)
    }
    if (visible("speaking")) {
      tf(part("chev"), `translate(${Math.max(0, osc(0.7)) * 3} 0)`)
      part<SVGPathElement>("under").style.opacity = osc(1.06) > -0.2 ? "1" : "0.15"
    }
    if (visible("awaiting")) tf(part("qmark"), `rotate(${osc(1.8) * 7} 206 76)`)
    if (visible("success"))
      (
        [
          [1, 192, 60],
          [2, 203, 78],
          [3, 207, 96],
        ] as const
      ).forEach(([i, x, y]) => {
        const s = 0.8 + 0.2 * (osc(1.4, -i * 0.15) * 0.5 + 0.5)
        tf(part(`ray-${i}`), `translate(${x} ${y}) scale(${s}) translate(${-x} ${-y})`)
      })
    if (visible("error"))
      [1, 2].forEach(
        (i) => (part<SVGLineElement>(`err-ray-${i}`).style.opacity = String(0.55 + 0.45 * (osc(0.9, -i * 0.25) * 0.5 + 0.5))),
      )
  }

  svg.addEventListener("pointerdown", poke)
  return {
    setPose,
    /** Still mode renders each pose as a static frame: used for reduced motion, offscreen or `animated={false}`. */
    setStill(still: boolean) {
      if (still === motion.still && motion.enteredAt) return
      motion.still = still
      if (still) {
        loop.delete(update)
        motion.actions = []
        motion.expression = motion.pose === "error" ? "sad" : EXPRESSION[motion.pose]
        return update(clock.t, 0)
      }
      loop.add(update)
      start()
    },
    dispose() {
      loop.delete(update)
      svg.removeEventListener("pointerdown", poke)
    },
  }
}

function restingGaze(pose: MascotPose) {
  if (pose === "thinking") return { x: 0.3, y: -0.8 }
  if (pose === "speaking") return { x: 0.1, y: 0.4 }
  if (pose === "error") return { x: -0.1, y: 0.5 }
  if (pose === "awaiting") return { x: 0.6, y: -0.4 }
  return { x: 0, y: 0 }
}

// One animation frame and one pointer listener serve every mascot on the page.
const clock = { t: 0, last: 0, running: false }
const pointer = { x: 0, y: 0, t: -99, seen: false, listening: false }
const loop = new Set<(t: number, dt: number) => void>()

function start() {
  if (!pointer.listening) {
    pointer.listening = true
    window.addEventListener(
      "pointermove",
      (event) => Object.assign(pointer, { x: event.clientX, y: event.clientY, t: clock.t, seen: true }),
      { passive: true },
    )
  }
  if (clock.running) return
  clock.running = true
  clock.last = performance.now()
  requestAnimationFrame(tick)
}

function tick(now: number) {
  const dt = Math.min(0.05, (now - clock.last) / 1000)
  clock.last = now
  clock.t += dt
  loop.forEach((update) => update(clock.t, dt))
  if (!loop.size) {
    clock.running = false
    return
  }
  requestAnimationFrame(tick)
}

function project(x: number, y: number, yaw: number, pitch: number) {
  const u = (x - HEAD.cx) / HEAD.rx
  const v = (y - HEAD.cy) / HEAD.ry
  const z = Math.sqrt(Math.max(0.04, 1 - u * u - v * v))
  const u1 = u * Math.cos(yaw) + z * Math.sin(yaw)
  const z1 = -u * Math.sin(yaw) + z * Math.cos(yaw)
  const v2 = v * Math.cos(pitch) + z1 * Math.sin(pitch)
  const z2 = -v * Math.sin(pitch) + z1 * Math.cos(pitch)
  return {
    x: HEAD.cx + u1 * HEAD.rx,
    y: HEAD.cy + v2 * HEAD.ry,
    sx: clamp(z1 / z, 0.4, 1.2),
    sy: clamp(z2 / Math.max(0.05, z1), 0.5, 1.2),
    z: z2,
  }
}

function kf(p: number, frames: readonly Key[]) {
  if (p <= frames[0][0]) return frames[0][1]
  const i = frames.findIndex((frame) => p <= frame[0])
  if (i < 0) return frames[frames.length - 1][1]
  const [t0, v0] = frames[i - 1]
  const [t1, v1, ease] = frames[i]
  return v0 + (v1 - v0) * EASE[ease ?? "inOut"]((p - t0) / (t1 - t0 || 1))
}

function spring(s: Spring, target: number, w: number, z: number, dt: number) {
  // Substep so stiff springs stay stable when frames are long.
  const n = Math.max(1, Math.ceil((dt * w) / 0.25))
  const h = dt / n
  for (let i = 0; i < n; i++) {
    s.v += (w * w * (target - s.x) - 2 * z * w * s.v) * h
    s.x += s.v * h
  }
  if (!Number.isFinite(s.x)) Object.assign(s, { x: target, v: 0 })
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

// Round numbers so tiny values never serialize as exponent notation, which SVG transforms reject.
function tf(node: Element, value: string) {
  node.setAttribute(
    "transform",
    value.replace(/-?[\d.]+(e[-+]?\d+)?/gi, (n) => String(Number(Number(n).toFixed(3)))),
  )
}
