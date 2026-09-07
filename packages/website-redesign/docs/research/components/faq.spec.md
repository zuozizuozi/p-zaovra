# InstallAndFAQ specification

- Target: `.install` + `.faq`; interaction: copy command and single-open accordion.
- Compact install block replaces reference email capture: `curl -fsSL https://zaovra.com/install | bash`, copy button, and Download desktop CTA.
- FAQ uses eight 73px closed rows on desktop with 1px separators and mono indices. Questions cover what Zaovra is, local-first meaning, model/provider choice, data handling, terminal-only use, desktop support, project context and open-source status.
- Open answer animates height/opacity and keeps the question visible. Keyboard support: Enter/Space, Escape closes language menu only.
- Mobile: 24px gutters, question text wraps naturally, answer remains at least 16px.
