import type { CanvasNodeMetadata } from "@/types/canvas";

// Older local drafts can retain a completed task while losing the transient
// resourceReloadAvailable flag during a document rebase. The task identity is
// enough to offer recovery: the handler rechecks that the original task really
// succeeded before it materializes anything.
export function canReloadCanvasGenerationResult(metadata: CanvasNodeMetadata | undefined) {
    if (metadata?.resourceReloadAvailable) return true;
    return metadata?.status === "error"
        && Boolean(metadata?.taskId)
        && metadata?.taskStatus === "succeeded"
        && metadata?.generationErrorCode !== "result_target_unavailable"
        && !metadata?.content
        && !metadata?.storageKey;
}
