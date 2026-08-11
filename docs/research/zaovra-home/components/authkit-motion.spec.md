# AuthKit Motion Specification

## Scope lock

- Target: `packages/console/app/src/routes/home-authkit-motion.css`
- CSS-only enhancement over the existing homepage. No content or DOM changes.
- All motion must be disabled by `prefers-reduced-motion: reduce`.

## Page-load choreography

- Header: fade/slide from `translateY(-12px)` over 700ms.
- Hero eyebrow, heading, copy, actions, platform note: staggered fade-up, 70–110ms between elements, 700–900ms duration.
- Hero product stage: fade from opacity 0 plus `translate3d(0,24px,0) rotateX(4deg)` over 1000ms.
- Proof rail cells: short staggered rise.
- Use `cubic-bezier(.22,1,.36,1)` for reveals.

## Ambient motion

- Spotlight halo drifts/scales over 14–18 seconds.
- Hero product stage floats 6–8px over 7–9 seconds.
- Blueprint background drifts no more than 16px over 18–24 seconds.
- WorkGraph dashed paths move continuously but slowly.
- Status dots use a subtle opacity/glow pulse.

## Hover/focus motion

- Buttons, provider rows, feature/access/open cards: translate `-2px` and brighten frost edge in 180–240ms.
- Text links move their arrow 3px.
- Product nodes may translate at most `-2px`; never rearrange.
- Provide visible `:focus-visible` rings using `rgba(152,192,239,.72)`.

## Scroll behavior

- No JS observers and no scroll-jacking.
- Use only browser-native scrolling and CSS animations.
- Avoid long repeated animations on text itself; movement belongs to background and product surfaces.

## Reduced motion

- Disable animation and transition globally within `[data-page="zaovra-home"]`.
- Remove perspective transforms and freeze background positions.

