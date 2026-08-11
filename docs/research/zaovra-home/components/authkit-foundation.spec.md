# AuthKit Visual Foundation Specification

## Scope lock

- Target: `packages/console/app/src/routes/home-authkit-foundation.css`
- Import after `index.css`; overrides only descendants of `[data-page="zaovra-home"]`.
- Keep every existing section, DOM node, link, string, product claim, and responsive content unchanged.
- Do not use AuthKit logos, illustrations, copy, or downloaded assets.

## Visual source

- User screenshots: current Zaovra workflow and WorkGraph sections.
- AuthKit public style reference: midnight canvas, frosted plates, ice-gradient display type, inset hairlines, 1200px content width, 120px vertical rhythm.
- Interaction model: CSS-driven entrance, hover, and ambient animation; no click-driven decorative tabs.

## Exact design tokens

- Canvas: `#05060f`
- Deep glass: `rgba(5, 6, 15, 0.97)`
- Frosted surface: `rgba(186, 214, 247, 0.03)`
- Strong frosted surface: `rgba(199, 211, 234, 0.06)`
- Heading: `#d8ecf8`
- Primary copy: `#d1e4fa`
- Secondary copy: `#c7d3ea`
- Muted/helper: `#9da7ba`
- Hairline: `rgba(186, 215, 247, 0.12)`
- Strong hairline: `rgba(186, 214, 247, 0.24)`
- Product accent: preserve Zaovra blue semantics but retune to ice blue `#98c0ef`; do not introduce AuthKit violet as the brand CTA.
- Success accent: cool teal `#79d8bc`; preview/warning accent remains restrained amber.
- Heading gradient: `linear-gradient(180deg, #d8ecf8 0%, #98c0ef 100%)`
- Blueprint grid: 1px lines at `rgba(186, 215, 247, 0.055)`, approximately 72–88px cells, edge masked.

## Typography

- Use installed/project fonts only; no copied font files.
- Display fallback: `Space Grotesk`, then existing sans token.
- UI/body: existing sans token.
- Eyebrow/code: existing mono token, uppercase, `0.1em` tracking.
- Hero: `clamp(54px, 6.3vw, 88px)`, weight 500, line-height `0.98`.
- Section heading: `clamp(38px, 4vw, 52px)`, weight 500, line-height `1.08`.
- Body: 16–18px, line-height `1.55–1.65`.

## Global page and header

- Page gets the midnight canvas, a top-center conic/radial spotlight, and a masked full-page blueprint grid.
- Header remains in the same location and retains all links. Style as a floating frosted capsule inside the 1200px grid: translucent background, 999px outer radius, inset hairline, subtle blur, top margin.
- Header CTA and all primary/secondary actions use pill geometry (`999px`). Primary Zaovra action uses luminous pale surface rather than a saturated blue rectangle.
- Hover: translate `-2px`, brighten inset edge, 180–240ms cubic easing.

## Sections

- Keep present widths and two-column/three-column structures.
- Replace solid divider lines with fading gradients.
- Section labels use mono uppercase ice copy. Add fading line ornaments with pseudo-elements where the DOM allows without changing content.
- Headings use the ice gradient with `background-clip:text`.
- Proof rail, feature grid, access cards, FAQ rows, open/local cards, and install options become low-opacity glass plates with 16px radii and inset shadows.
- Avoid conventional blue outlines or heavy solid fills.

## Responsive

- Desktop: max content width 1200px, large 100–120px section rhythm.
- Tablet 768px: preserve current stacking decisions; reduce hero and section padding, retain glass/header form.
- Mobile 390px: 20px page gutter, compact header, stacked actions/cards, no horizontal overflow, 40–72px section rhythm.

