import type { PreviewCommentDraft, PreviewCommentLocator } from "./PreviewCommentContext";

/** Translate a sandboxed iframe's viewport rect for parent-document portals. */
export function previewCommentLocatorInParentViewport(
  locator: PreviewCommentLocator,
  source: MessageEventSource | null,
  root: ParentNode | null,
): PreviewCommentLocator {
  if (!locator.rect || !source || source === window || !root) return locator;

  const frame = Array.from(root.querySelectorAll("iframe")).find(
    (candidate) => candidate.contentWindow === source,
  );
  if (!frame) return locator;

  const frameRect = frame.getBoundingClientRect();
  return {
    ...locator,
    rect: {
      ...locator.rect,
      x: frameRect.left + locator.rect.x,
      y: frameRect.top + locator.rect.y,
    },
  };
}

/**
 * Stable marker label shared by every preview surface. The composer drawer is
 * task-scoped, so marker numbering must use that same scope rather than the
 * provider-wide draft array (which can contain comments from other tasks).
 */
export function previewCommentTaskLabel(
  drafts: PreviewCommentDraft[],
  target: Pick<PreviewCommentDraft, "id" | "projectId" | "taskId">,
): string {
  const index = drafts
    .filter((draft) => draft.projectId === target.projectId && draft.taskId === target.taskId)
    .findIndex((draft) => draft.id === target.id);
  return String(index >= 0 ? index + 1 : 1);
}

/** Rehydrate a persisted draft into the complete marker payload expected by
 * preview renderers. Keeping the full locator is required for exact textRange
 * highlights; selector/xpath alone only identify the surrounding block. */
export function previewCommentMarkerData(
  draft: PreviewCommentDraft,
  label: string,
) {
  return {
    id: draft.id,
    label,
    selector: draft.locator.selector,
    xpath: draft.locator.xpath,
    extraBlocks: draft.locator.extraBlocks,
    locator: draft.locator,
    comment: draft.comment,
  };
}
