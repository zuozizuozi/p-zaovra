# AuthKit Product Surfaces Specification

## Scope lock

- Target: `packages/console/app/src/routes/home-authkit-stages.css`
- Style only current product-stage DOM: desktop workbench, provider stage, and WorkGraph preview.
- Do not change `home-product-stages.tsx`, labels, provider list, nodes, statuses, or product claims.

## Shared glass plate

- Radius: `16px`.
- Base: `rgba(5, 6, 15, 0.84)` over a faint cool radial wash.
- Elevation: `inset 0 1px 1px rgba(216,236,248,.20), inset 0 24px 48px rgba(168,216,245,.06), 0 24px 64px rgba(0,0,0,.42)`.
- Edge: use inset box-shadow, not a hard solid border.
- Add a pseudo-element edge sheen with a faint white-to-transparent gradient.

## Desktop workbench

- Preserve existing titlebar/sidebar/review/terminal/statusbar layout.
- Frame should float in a soft halo with slight perspective, never harm text legibility.
- Sidebar and terminal use deeper glass; active session uses `rgba(199,211,234,.08)` plus inset edge.
- Diff rows retain truthful add/remove semantics but reduce saturation to fit the monochrome system.
- Titlebar controls remain recognizable but subdued.

## Provider stage

- Each provider row is a nested frosted plate with 10px radius and inset hairline.
- Provider marks become cool monochrome glass icon tiles; keep provider initials.
- Hover raises the row 2px and adds an ice halo.
- BYOK badge is a pill with faint luminous fill.
- Credential and managed-access notes remain separate and fully legible.

## WorkGraph preview

- Keep the current grid and all Goal/Task/Evidence/Attempt/Repair/Replan/Pause-Resume content.
- Canvas uses `rgba(5,6,15,.52)` and 30px blueprint cells at `rgba(186,215,247,.08)`.
- Nodes use deep glass and the three-layer inset shadow.
- Graph paths use moving cool-blue dashed strokes; no fabricated metrics.
- Active/evidence status gets restrained teal. Preview badge stays amber.
- Queued node remains visibly lower opacity.

## Responsive

- At current tablet/mobile breakpoints, preserve existing DOM order.
- Avoid transforms that cause clipping or horizontal overflow.
- Reduce internal paddings and grid density on 390px without hiding real content.

