/** Convert a viewport rect to coordinates inside an overlay host using one
 * layout snapshot. Shared ancestor transforms cancel out in this subtraction,
 * so a marker measured during drawer entry animation cannot retain that
 * transient translation. */
export function rectRelativeTo(rect: DOMRect, origin: DOMRect): DOMRect {
  return new DOMRect(
    rect.left - origin.left,
    rect.top - origin.top,
    rect.width,
    rect.height,
  );
}

export function rectInViewport(rect: DOMRect, origin: DOMRect): DOMRect {
  return new DOMRect(
    origin.left + rect.left,
    origin.top + rect.top,
    rect.width,
    rect.height,
  );
}
