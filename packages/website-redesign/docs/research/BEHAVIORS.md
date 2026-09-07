# Behavior specification

- Global reveal: sections start in a lowered/faded state and gain `is-visible` near the 85% viewport threshold. Reference uses class-based intersection reveals; Zaovra should reproduce with GSAP/ScrollTrigger and reduced-motion fallback.
- Hero ticker: time-driven, seamless horizontal loop with uppercase mono labels and dot separators.
- Approach: click-driven. One of three step buttons is active; its body expands while the previous collapses and the right technical panel cross-fades. No scroll-driven tab switching.
- FAQ: click-driven disclosure; only one answer remains open. Height and opacity animate, summary marker rotates.
- Hover: navigation, chamfered buttons, capability cards, FAQ rows and footer links receive short 160–240ms feedback. Main actions translate subtly and brighten; cards shift border/glow, never scale aggressively.
- Terminal: pointer-driven shallow parallax on desktop only; static on coarse pointers and mobile.
- Language selector: click-driven popover, closes on outside click and Escape. English is default; options include 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Español, Français and Português.
- Responsive: 1200px rail below 1440; tablet keeps some two-column compositions; at <=760px every major grid is single-column and the header hides secondary nav links.
- Reduced motion: remove parallax, looping transforms and reveal offsets; preserve content and focus states.
