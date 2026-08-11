# ProductStages Specification

## Overview

- Target: `packages/console/app/src/component/home-product-stages.tsx`
- Interaction: static, with minor non-essential ambient animation.

## DesktopWorkbenchStage

- A single desktop window containing a project/session sidebar, compact conversation activity, file review diff, terminal output, context and permission chips.
- Every label maps to existing features; this is a faithful schematic of real surfaces, not a screenshot or a claim of an exact live session.
- No invented success rate, token saving, active user, or performance metric.

## ProviderStage

- Show provider rows for Anthropic, OpenAI, Google, GitHub Copilot, Custom endpoint, and Local compatible endpoint.
- Copy states that credentials are user-managed. Do not claim every provider is supported by WorkGraph V2.
- Include a separate managed access note: active subscription required.

## WorkGraphPreviewStage

- Include `Preview / in development` badge in visible text.
- Show a goal and a small dependency chain with task states, plus Attempt, Evidence, Repair and Replan labels.
- Do not show remote worker scale, geographic regions, SLAs, success percentages, or fake numeric metrics.

## Styling

- Product chrome uses 11–13px mono type.
- Window background `#081322`; nested panels `#0d1b2f`; border `rgba(126,157,205,.22)`.
- Active accents use `#2f6bff`; success/evidence uses `#62d8a0`; paused/preview uses `#f2bd65`.
- Provide semantic HTML where practical; purely decorative connectors are `aria-hidden`.

