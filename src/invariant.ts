/**
 * The plugin deliberately adds no custom DeepSeek Harness Session events.
 * Its durable contract is an owned JSONL event log whose reducer is validated
 * in the host package, so no Harness session-log invariant extension is needed.
 */
export const invariant = Object.freeze({
  sessionEventsAdded: false,
  reason: 'Cybersyn control events are isolated in the plugin-owned append-only store.',
})
