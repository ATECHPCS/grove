/** Toggle one detail in a block-scoped, mutually exclusive accordion. */
export function nextExpandedToolDetail(
  currentKey: string | null,
  clickedKey: string,
): string | null {
  return currentKey === clickedKey ? null : clickedKey;
}
