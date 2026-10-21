import type { CanvasNodeMetadata } from "@/types/canvas";

const KEPT_CANVAS_RESULT_CODES = new Set(["canvas_conflict", "download_failed", "result_apply_failed"]);

function isKeptCanvasResultCode(code: string | undefined) {
    return Boolean(code && KEPT_CANVAS_RESULT_CODES.has(code));
}

// Older local drafts can retain a completed task while losing the transient
// resourceReloadAvailable flag during a document rebase. The task identity is
// enough to offer recovery: the handler rechecks that the original task really
// succeeded before it materializes anything.
export function canReloadCanvasGenerationResult(metadata: CanvasNodeMetadata | undefined) {
    if (metadata?.resourceReloadAvailable) return true;
    if (!metadata?.taskId || metadata?.taskStatus !== "succeeded") return false;
    if (metadata.generationErrorCode === "result_target_unavailable") return false;
    if (isKeptCanvasResultCode(metadata.generationErrorCode)) return true;
    return metadata.status === "error" && !metadata.content && !metadata.storageKey;
}
