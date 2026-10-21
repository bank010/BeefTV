import { expect, test } from "bun:test";

import { buildVideoGenerationMetadata } from "@/lib/canvas/canvas-project-generation";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("comfy workflow video ignores stale frame ids that are not in reference set", () => {
    const config = { ...defaultConfig, taskWorkflowProvider: "comfyui" as const, model: "some-video-model" };
    const node = {
        id: "video-gen",
        type: CanvasNodeType.Video,
        metadata: {
            videoStartFrameNodeId: "stale-frame",
            videoEndFrameNodeId: "another-stale",
            videoMiddleFrameNodeId: "middle-stale",
        },
    } as CanvasNodeData;
    const context = {
        referenceImages: [{ id: "ref-image", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" }],
        referenceVideos: [{ id: "ref-video", name: "ref.mp4", type: "video/mp4", url: "https://example.com/ref.mp4" }],
        referenceAudios: [],
    };
    expect(() => buildVideoGenerationMetadata(node, context, config)).not.toThrow();
    const metadata = buildVideoGenerationMetadata(node, context, config);
    expect(metadata.videoStartFrameNodeId).toBeUndefined();
    expect(metadata.videoEndFrameNodeId).toBeUndefined();
    expect(metadata.videoMiddleFrameNodeId).toBeUndefined();
});
