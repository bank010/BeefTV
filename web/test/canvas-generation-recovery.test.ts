import { expect, test } from "bun:test";

import { canReloadCanvasGenerationResult } from "@/lib/canvas/canvas-generation-recovery";

test("completed task can be recovered when a legacy draft lost its reload marker", () => {
    expect(canReloadCanvasGenerationResult({
        status: "error",
        taskId: "task-1",
        taskStatus: "succeeded",
        generationErrorCode: "canvas_conflict",
    })).toBe(true);
});

test("recovery remains unavailable when the original target is gone or output already exists", () => {
    expect(canReloadCanvasGenerationResult({
        status: "error",
        taskId: "task-1",
        taskStatus: "succeeded",
        generationErrorCode: "result_target_unavailable",
    })).toBe(false);
    expect(canReloadCanvasGenerationResult({
        status: "error",
        taskId: "task-1",
        taskStatus: "succeeded",
        content: "/api/resources/ready/file",
    })).toBe(false);
});

test("kept canvas results stay reloadable even when the node still shows a previous image", () => {
    expect(canReloadCanvasGenerationResult({
        status: "success",
        taskId: "task-1",
        taskStatus: "succeeded",
        generationErrorCode: "canvas_conflict",
        content: "/api/resources/ready/file",
    })).toBe(true);
});
