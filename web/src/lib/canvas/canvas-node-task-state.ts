import type { CanvasNodeData } from "@/types/canvas";

/** A historical taskId is not a lock. Only live task states / submission are. */
export function isCanvasNodeGenerating(node: CanvasNodeData | undefined, runningNodeId?: string | null) {
    if (!node) return false;
    if (runningNodeId === node.id) return true;
    const meta = node.metadata;
    if (meta?.taskId && (meta.taskStatus === "queued" || meta.taskStatus === "running")) return true;
    if (meta?.taskStatus === "succeeded" && !meta.content && !meta.storageKey) return true;
    if (["succeeded", "failed", "cancelled"].includes(meta?.taskStatus || "")) return false;
    return meta?.status === "loading" || Boolean(meta?.taskId && meta.status !== "success" && meta.status !== "error");
}

/** UI / duplicate-submit guard: queued, running, or actively writing results back. */
export function isCanvasNodeActivelyGenerating(
    node: CanvasNodeData | undefined,
    runningNodeId?: string | null,
    isLiveRequest?: (nodeId: string) => boolean,
) {
    if (!node) return false;
    if (runningNodeId === node.id) return true;
    if (isLiveRequest?.(node.id)) return true;
    const meta = node.metadata;
    if (!meta) return false;
    if (meta.taskId && (meta.taskStatus === "queued" || meta.taskStatus === "running")) return true;
    if (meta.taskStatus === "succeeded" && !meta.content && !meta.storageKey && meta.status === "loading") return true;
    if (meta.generationSubmissionState === "submitting" || meta.generationSubmissionState === "unknown") {
        return Boolean(isLiveRequest?.(node.id));
    }
    return false;
}
