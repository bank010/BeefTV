import { expect, test } from "bun:test";

import { applyComfyOmniReferenceMediaLimits, clampComfyReferenceVideoOutputSeconds, comfyReferenceVideoDurationError } from "@/lib/comfy-omni-reference-temp-limit";
import { modelCompatibilityError } from "@/lib/model-selection";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { defaultConfig, resolveWorkflowFieldsForExecution, type AiConfig } from "@/stores/use-config-store";
import { workflowMediaInputLimitForWorkflow } from "@/lib/model-capabilities";

function comfyVideoConfig(): AiConfig {
    const workflowId = "ref-video-flow";
    return {
        ...defaultConfig,
        comfyUI: {
            ...defaultConfig.comfyUI,
            enabled: true,
            baseUrl: "http://127.0.0.1:8188",
            workflows: [
                {
                    workflowId,
                    title: "参考生视频",
                    capability: "video",
                    workflowJson: {
                        "1": { class_type: "SaveVideo", inputs: { filename_prefix: "out" } },
                        "10": { class_type: "VHS_LoadVideo", inputs: { video: "ref.mp4" } },
                    },
                    fields: [],
                },
            ],
        },
        videoModel: `comfyui-workflow::${workflowId}`,
    };
}

test("VHS_LoadVideo empty video widget resolves to a reference video slot", () => {
    const fields = resolveWorkflowFieldsForExecution({
        capability: "video",
        workflowJson: { "10": { class_type: "VHS_LoadVideo", inputs: { video: "" } } },
        fields: [],
    });
    expect(workflowMediaInputLimitForWorkflow(fields, undefined, ["referencevideo", "video", "referencevideos"])).toBe(1);
});

test("comfy video workflow applies 9/3/3 media limits when mapping is empty", () => {
    const config = comfyVideoConfig();
    const model = config.videoModel;
    const profile = modelCapabilityConfigFor(config, model).video!;
    expect(profile.references.maxImages).toBe(9);
    expect(profile.references.maxVideos).toBe(3);
    expect(profile.references.maxAudios).toBe(3);
    expect(profile.operations).toContain("reference_to_video");
});

test("reference video caps output duration at 10 seconds", () => {
    const config = comfyVideoConfig();
    const model = config.videoModel;
    expect(comfyReferenceVideoDurationError(config, model, 1, "15")).toContain("10");
    expect(clampComfyReferenceVideoOutputSeconds(config, model, 1, "15")).toBe("10");
    expect(modelCompatibilityError(config, model, {
        capability: "video",
        input: { textCount: 1, imageCount: 1, videoCount: 1, audioCount: 0, characterCount: 0 },
        videoSeconds: "5",
        videoOperation: "reference_to_video",
    })).toBe("");
    expect(applyComfyOmniReferenceMediaLimits(config, "other::model", { maxImages: 0, maxVideos: 0, maxAudios: 0 })).toEqual({ maxImages: 0, maxVideos: 0, maxAudios: 0 });
});
