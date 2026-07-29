import type { PreviewCommentDraft } from "./PreviewCommentContext";

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
