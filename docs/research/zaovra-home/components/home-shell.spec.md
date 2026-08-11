# HomeShell Specification

## Overview

- Target: `packages/console/app/src/routes/index.tsx`
- Styles: `packages/console/app/src/routes/index.css`
- Interaction: static page with anchor navigation and native details FAQ.

## Structure

- Page-specific header and navigation.
- Hero copy beside `DesktopWorkbenchStage`.
- Workflow strip.
- Desktop workbench, BYOK, WorkGraph preview, local/open-source, access comparison, FAQ, CTA, footer/legal.

## Content requirements

- Hero headline: durable, inspectable work in the developer’s real workspace; do not mention WorkGraph as generally available.
- Include desktop beta status where relevant.
- BYOK language must explicitly cover user-managed credentials and custom/local OpenAI-compatible endpoints.
- Managed-model language must require an active Zaovra subscription.
- WorkGraph must say Preview or In development every time its panel is introduced.
- No Zen, free model, anonymous inference, trial, unlimited, enterprise-ready, or absolute privacy copy.

## Responsive behavior

- 1440px: header and hero align to 1240px container; hero copy 5 columns and stage 7 columns.
- 768px: stack hero; retain two-column comparison cards.
- 390px: single column; hide secondary nav group; CTAs fill available width; all panels fit within viewport.

