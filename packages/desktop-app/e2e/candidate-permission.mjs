export async function withCandidatePermission(page, review) {
  const pending = await page.evaluateHandle(() => {
    const visible = (element) => {
      const { width, height } = element.getBoundingClientRect()
      return width > 0 && height > 0 && getComputedStyle(element).visibility === "visible"
    }
    const read = () => {
      const cards = document.querySelectorAll('[data-notification-target^="permission:"]')
      if (cards.length > 1) throw new Error("ambiguous permission card")
      const card = cards[0]
      if (!card || !visible(card)) return null
      const details = card.querySelectorAll('[data-slot="permission-details"] > code')
      const commands = card.querySelectorAll('[data-slot="permission-command"]')
      if (details.length !== 1 || commands.length !== 1) throw new Error("ambiguous permission details")
      return {
        card,
        id: card.getAttribute("data-notification-target"),
        permission: details[0].textContent,
        patterns: [...card.querySelectorAll('[data-slot="permission-patterns"] code')].map((code) => code.textContent),
        command: commands[0].textContent,
      }
    }
    const reviewed = read()
    if (!reviewed) return null

    let clicked = false
    return {
      request: { id: reviewed.id, permission: reviewed.permission, patterns: reviewed.patterns },
      approveOnce(command) {
        const current = read()
        if (
          !current ||
          current.card !== reviewed.card ||
          current.id !== reviewed.id ||
          current.id === "permission:" ||
          current.permission !== reviewed.permission ||
          current.permission !== "bash" ||
          reviewed.patterns.length !== 1 ||
          reviewed.patterns[0] !== command ||
          reviewed.command !== command ||
          current.patterns.length !== 1 ||
          current.patterns[0] !== command ||
          current.command !== command
        ) {
          throw new Error("permission card changed before approval")
        }

        const buttons = [...current.card.querySelectorAll('[data-slot="permission-footer-actions"] button')].filter(
          (button) => /^(允许一次|Allow once)$/.test(button.textContent.trim()),
        )
        if (
          clicked ||
          buttons.length !== 1 ||
          !visible(buttons[0]) ||
          buttons[0].disabled ||
          buttons[0].closest('[inert], [aria-disabled="true"]')
        ) {
          throw new Error("permission action is ambiguous or unavailable")
        }

        // Keep the final identity check and DOM click in one renderer task.
        clicked = true
        buttons[0].click()
      },
    }
  })
  try {
    const request = await pending.evaluate((state) => state?.request)
    if (request) {
      await review(request, (command) => pending.evaluate((state, value) => state.approveOnce(value), command))
    }
  } finally {
    await pending.dispose()
  }
}
