# Zaovra Home Behaviors

## Interaction model

- The page keeps native scrolling and the frozen content sequence. There are no decorative tabs, carousels, auto-cycling panels, or fake live metrics.
- Header anchors use native smooth scrolling only when reduced motion is not requested.
- Product surfaces have subtle hover/focus elevation on desktop but never hide essential content behind hover.
- FAQ uses native `details`/`summary` so the interaction works without custom state machinery.
- The install-command copy control retains the existing clipboard feedback pattern.

## Motion

- Header and hero content enter with a 70–110ms stagger and `cubic-bezier(.22,1,.36,1)` easing.
- Hero product surface enters over 1000ms with a shallow perspective rise, then floats 6–8px over 7–9 seconds.
- Spotlight and blueprint layers drift slowly over 14–24 seconds.
- WorkGraph paths move slowly; state lights use a restrained glow pulse.
- Cards use a 180–240ms hover transition with a maximum translateY(-2px).
- Do not introduce scroll-jacking, Lenis, parallax, sticky tab switching, or autoplay video.
- Mobile removes perspective and long-running ambient drift where it could interfere with reading.
- All animation and nonessential transition is disabled by `prefers-reduced-motion`.

## Accessibility

- One h1, logical h2 hierarchy, visible keyboard focus, descriptive link names.
- Decorative UI chrome is `aria-hidden`; explanatory text is normal DOM text outside screenshots.
- Minimum body text 16px; compact product chrome may be 11–13px with sufficient contrast.
- Product panels do not rely on color alone for status.

