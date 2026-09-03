export type ComposerPresenceUpdate = "present" | "absent" | "settling-empty";

/**
 * Decide when the React-facing composer presence state should change.
 *
 * Text expansion tools commonly replace a trigger by emitting Backspace until
 * the contentEditable is briefly empty, then injecting the expansion. Letting
 * that transient empty state re-render the composer can interrupt the browser's
 * active editing transaction and corrupt the replacement. DOM input remains
 * authoritative; only the derived UI state waits for the replacement burst to
 * settle.
 */
export function composerPresenceUpdate(
  hasDomContent: boolean,
  hasAttachments: boolean,
  settleEmpty: boolean,
): ComposerPresenceUpdate {
  if (hasDomContent || hasAttachments) return "present";
  return settleEmpty ? "settling-empty" : "absent";
}
