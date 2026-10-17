import { afterEach, describe, expect, test } from "bun:test";
import { comfyUIOutputDimensions } from "@/lib/comfyui-output-size";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { modelCapabilityConfigFor, workflowImageCapabilityConfig } from "@/lib/model-capabilities";
import { imageSizePresets } from "@/lib/image-size-presets";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { comfyUIWorkflowModel, defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import { COMFYUI_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildNodeConfig } from "@/components/canvas/canvas-node-prompt-panel";

const originalStatuses = { ...usePluginStore.getState().runtimeStatuses };
afterEach(() => usePluginStore.getState().setRuntimeStatuses(originalStatuses));

function fixture(): AiConfig {
    const workflowId = "workflows/qwen.json";
    const model = comfyUIWorkflowModel(workflowId);
    return {
        ...defaultConfig, channels: [], model, imageModel: model,
        comfyUI: {
            ...defaultConfig.comfyUI, enabled: true, baseUrl: "https://comfy.example", selectedWorkflowId: workflowId,
            workflows: [{
                workflowId, title: "Qwen", capability: "image",
                workflowJson: {
                    "461": { class_type: "SaveImageAdvanced", inputs: { images: ["511", 0] } },
                    "510": { class_type: "EmptyLatentImage", inputs: { width: 960, height: 1440, batch_size: 1 } },
                    "511": { class_type: "VAEDecode", inputs: { samples: ["512", 0] } },
                    "512": { class_type: "KSampler", inputs: { latent_image: ["513", 0], positive: ["515", 0] } },
                    "513": { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: ["510", 0], on_false: ["515", 2] } },
                    "515": { class_type: "TextEncodeQwenImage21", inputs: { resolution: 0 } },
                    "600": { class_type: "ImageResize+", inputs: { width: 512, height: 512 } },
                    "601": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024 } },
                },
                fields: [
                    ...(["width", "height"] as const).map((fieldName) => ({ nodeId: "510", classType: "EmptyLatentImage", fieldName, fieldValue: fieldName === "width" ? 960 : 1440, enabled: false, role: "internal" as const, source: "", sourceAutomatic: false, safeToOverride: true })),
                    { nodeId: "515", classType: "TextEncodeQwenImage21", fieldName: "resolution", fieldValue: 0, enabled: true, source: "", sourceAutomatic: false },
                ],
            }],
        },
    };
}

describe("ComfyUI output dimensions", () => {
    test("reads the active latent path, rather than encoder resolution or disconnected nodes", () => {
        const config = fixture();
        const workflow = config.comfyUI.workflows[0];
        expect(comfyUIOutputDimensions(workflow.workflowJson, workflow.fields)).toMatchObject({ nodeId: "510", size: "960x1440" });
        const profile = modelCapabilityConfigFor(config, config.model).image!;
        expect(profile.size.default).toBe("960x1440");
        expect(profile.size.values).not.toContain("0");
        expect(imageSizePresets(profile).map((preset) => preset.tier)).toContain("2k");
        expect(profile.size.values).toContain("2048x2048");
        expect(profile.size.allowCustom).toBe(true);
        const presets = imageSizePresets(profile);
        expect(new Set(presets.map(p => `${p.tier}:${p.ratio}`)).size).toBe(presets.length);
    });

    test("does not infer selectable output dimensions across unknown, dynamic, linked or ambiguous paths", () => {
        for (const change of [
            { "513": { class_type: "ComfySwitchNode", inputs: { switch: false, on_true: ["510", 0], on_false: ["515", 2] } } },
            { "513": { class_type: "ComfySwitchNode", inputs: { switch: ["toggle", 0], on_true: ["510", 0] } } },
            { "510": { class_type: "EmptyLatentImage", inputs: { width: ["size", 0], height: 1440 } } },
            { "510": { class_type: "UnknownLatent", inputs: { width: 960, height: 1440 } } },
            { "513": { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: ["513", 0] } } },
            { "700": { class_type: "SaveImage", inputs: { images: ["other", 0] } } },
        ]) {
            expect(comfyUIOutputDimensions({ ...fixture().comfyUI.workflows[0].workflowJson, ...change })).toBeUndefined();
        }
        expect(workflowImageCapabilityConfig([{ fieldName: "resolution", fieldValue: 0 }]).size.default).toBe("auto");
        expect(comfyUIOutputDimensions(fixture().comfyUI.workflows[0].workflowJson, [{ nodeId: "513", fieldName: "switch", fieldValue: false }])).toBeUndefined();
    });

    for (const type of [CanvasNodeType.Image, CanvasNodeType.Config]) {
        test(`${type}: selected dimensions survive canvas configuration and task serialization`, async () => {
            usePluginStore.getState().setRuntimeStatuses({ ...originalStatuses, [COMFYUI_PLUGIN_ID]: "enabled" });
            const config = fixture();
            const original = structuredClone(config);
            const node: CanvasNodeData = { id: "image", title: "Image", type, position: { x: 0, y: 0 }, width: 300, height: 300, metadata: { model: config.model } };
            expect(buildGenerationConfig(config, node, "image").size).toBe("960x1440");
            expect(buildNodeConfig(config, node, "image", { capability: "image" }).size).toBe("960x1440");
            for (const size of ["2048x2048", "1280x960"]) {
                node.metadata!.size = size;
                const generation = buildGenerationConfig(config, node, "image");
                expect(generation.size).toBe(size);
                expect(buildNodeConfig(config, node, "image", { capability: "image" }).size).toBe(size);
                const task = await prepareBackendGenerationTask({ mode: "image", prompt: "Test", config: generation });
                const submitted = task.input!.config as { size: string; workflowFields: Array<{ nodeId: string; fieldName: string; fieldValue: unknown; enabled?: boolean }>; workflowJson: unknown };
                expect(submitted.size).toBe(size);
                const [width, height] = size.split("x").map(Number);
                expect(submitted.workflowFields.filter((field) => field.nodeId === "510")).toMatchObject([
                    { fieldName: "width", fieldValue: width, enabled: true },
                    { fieldName: "height", fieldValue: height, enabled: true },
                ]);
                expect(submitted.workflowFields.find((field) => field.nodeId === "515")?.fieldValue).toBe(0);
                expect(submitted.workflowJson).toEqual(original.comfyUI.workflows[0].workflowJson);
            }
            node.metadata!.size = "0x1440";
            await expect(prepareBackendGenerationTask({ mode: "image", prompt: "Test", config: buildGenerationConfig(config, node, "image") })).rejects.toThrow("正整数");
            expect(config).toEqual(original);
        });
    }
});
