export function createImeKeyOwnership() {
  let composing = false

  return {
    start() {
      composing = true
    },
    end() {
      composing = false
    },
    owns(event: KeyboardEvent) {
      return composing || event.isComposing || event.keyCode === 229
    },
  }
}
