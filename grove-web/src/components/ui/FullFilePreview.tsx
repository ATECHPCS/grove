import type { Ref } from "react";
import {
  getPreviewRenderer,
  type PreviewRenderer,
  type RenderFullProps,
} from "../Review/previewRenderers";
import { PreviewCommentHost } from "../Review/PreviewCommentHost";
import {
  VirtualizedMarkdownRenderer,
  type VirtualizedMarkdownHandle,
  type VirtualizedMarkdownHeading,
} from "./VirtualizedMarkdownRenderer";
import { isVirtualizedMarkdownPreview } from "./filePreviewPolicy";

export interface FullFilePreviewProps extends Omit<RenderFullProps, "fileName"> {
  fileName: string;
  /** Reuse a renderer already resolved by the caller when available. */
  renderer?: PreviewRenderer;
  className?: string;
  markdownRef?: Ref<VirtualizedMarkdownHandle>;
  onMarkdownHeadingsChange?: (headings: VirtualizedMarkdownHeading[]) => void;
  onMarkdownSearchStateChange?: (total: number, current: number) => void;
  onMarkdownScrollerRef?: (element: HTMLElement | null) => void;
}

/**
 * The single full-file preview boundary used by Editor, Artifacts/Resources,
 * and full-file Review. File-type selection, layout ownership, and the
 * ordinary/virtualized Markdown policy live here so surfaces cannot drift.
 * Diff-segment rendering intentionally remains separate because it does not
 * receive a complete file.
 */
export function FullFilePreview({
  fileName,
  renderer: providedRenderer,
  className = "",
  content,
  downloadUrl,
  onImageClick,
  onSvgClick,
  previewComment,
  sketchContext,
  location,
  markdownRef,
  onMarkdownHeadingsChange,
  onMarkdownSearchStateChange,
  onMarkdownScrollerRef,
}: FullFilePreviewProps) {
  const renderer = providedRenderer ?? getPreviewRenderer(fileName, "full");
  if (!renderer) return null;

  if (renderer.id === "markdown" && isVirtualizedMarkdownPreview(fileName, content)) {
    return (
      <div
        className={`h-full min-h-0 w-full ${className}`.trim()}
        data-file-preview-renderer="markdown"
        data-file-preview-virtualized="true"
      >
        <PreviewCommentHost previewComment={previewComment} fill>
          <VirtualizedMarkdownRenderer
            ref={markdownRef}
            content={content}
            onImageClick={onImageClick}
            onMermaidClick={onSvgClick}
            onD2Click={onSvgClick}
            sketchContext={sketchContext}
            sketchRenderMode="image"
            location={location}
            renderMode="document"
            onHeadingsChange={onMarkdownHeadingsChange}
            onSearchStateChange={onMarkdownSearchStateChange}
            onScrollerRef={onMarkdownScrollerRef}
            style={{ height: "100%" }}
          />
        </PreviewCommentHost>
      </div>
    );
  }

  const layoutClass = renderer.layout === "fill"
    ? "h-full min-h-0 w-full relative"
    : "w-full p-5";

  return (
    <div
      className={`${layoutClass} ${className}`.trim()}
      data-file-preview-renderer={renderer.id}
      data-file-preview-virtualized="false"
    >
      {renderer.renderFull({
        content,
        fileName,
        downloadUrl,
        onImageClick,
        onSvgClick,
        previewComment,
        sketchContext,
        location,
      })}
    </div>
  );
}
