import { afterEach, describe, expect, test } from "bun:test";

import { COMFYUI_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";

const originalRuntimeStatuses = { ...usePluginStore.getState().runtimeStatuses };

afterEach(() => {
    usePluginStore.getState().setRuntimeStatuses(originalRuntimeStatuses);
});

describe("ComfyUI generation task", () => {
    test("a video graph without a duration control remains submittable while declared limits are enforced", async () => {
        usePluginStore.getState().setRuntimeStatuses({ ...originalRuntimeStatuses, [COMFYUI_PLUGIN_ID]: "enabled" });
        const workflowId = "video-without-duration";
        const graph = { "1": { class_type: "VideoGenerator", inputs: { prompt: "default" } } };
        const config: AiConfig = {
            ...defaultConfig,
            model: `comfyui-workflow::${workflowId}`,
            taskWorkflowProvider: "comfyui",
            videoSeconds: "6",
            comfyUI: {
                enabled: true,
                baseUrl: "http://comfyui.test:8188",
                apiKey: "",
                selectedWorkflowId: workflowId,
                workflows: [{ workflowId, title: "Video", capability: "video", workflowJson: graph, fields: [{ nodeId: "1", fieldName: "prompt", fieldValue: "default", source: "prompt", enabled: true }] }],
            },
        };
        const input = { mode: "video" as const, prompt: "moving scene", config };
        const task = await prepareBackendGenerationTask(input);
        expect(task.type).toBe("canvas_video");
        expect(task.provider).toBe("comfyui");
        expect(task.input?.config.workflowJson).toEqual(graph);
        expect(task.input?.config.workflowFields).toHaveLength(1);
        await expect(prepareBackendGenerationTask({ ...input, referenceVideos: [{ id: "ref", name: "video.mp4", type: "video/mp4", url: "https://example.test/video.mp4", durationMs: 2000 }] })).rejects.toThrow("最多支持 0 个参考视频");

        config.comfyUI.workflows[0].fields.push({ nodeId: "1", fieldName: "duration", fieldValue: 5, source: "", enabled: true, fieldType: "NUMBER", options: [5, 10] });
        await expect(prepareBackendGenerationTask(input)).rejects.toThrow("视频时长不在当前模型支持范围内");
        config.videoSeconds = "5";
        expect((await prepareBackendGenerationTask(input)).provider).toBe("comfyui");
    });

    test("submits the selected workflow and isolated provider configuration", async () => {
        usePluginStore.getState().setRuntimeStatuses({ ...originalRuntimeStatuses, [COMFYUI_PLUGIN_ID]: "enabled" });
        const config: AiConfig = {
            ...defaultConfig,
            taskWorkflowProvider: "comfyui",
            comfyUI: {
                enabled: true,
                baseUrl: "http://comfyui.test:8188",
                apiKey: "comfyui-api-key",
                selectedWorkflowId: "workflow-1",
                workflows: [{
                    workflowId: "workflow-1",
                    title: "Text to image",
                    capability: "image",
                    workflowJson: { "1": { class_type: "SaveImage" } },
                    fields: [{ nodeId: "1", fieldName: "prompt", fieldValue: "workflow default", source: "prompt" }],
                }],
            },
        };

        const task = await prepareBackendGenerationTask({ mode: "image", prompt: "A studio portrait", config });

        expect(task.provider).toBe("comfyui");
        expect(task.model).toBe("ComfyUI · Text to image");
        expect(task.input?.execution).toEqual({
            provider: "comfyui",
            kind: "workflow",
            interfaceType: "comfyui-workflow-image",
            name: "Text to image",
            workflowId: "workflow-1",
        });
        const providerConfig = task.input?.config as Record<string, unknown>;
        expect(providerConfig).toMatchObject({
            baseUrl: "http://comfyui.test:8188",
            apiKey: "comfyui-api-key",
            interfaceType: "comfyui-workflow-image",
            model: "workflow-1",
            workflowId: "workflow-1",
            workflowJson: { "1": { class_type: "SaveImage" } },
            workflowFields: [{ nodeId: "1", fieldName: "prompt", fieldValue: "workflow default", source: "prompt" }],
            secretKey: "",
            headers: [],
        });
        expect(JSON.stringify(task.input?.execution)).not.toContain("api-key");
    });

    test("rejects a selected workflow whose capability does not match the generation mode", async () => {
        usePluginStore.getState().setRuntimeStatuses({ ...originalRuntimeStatuses, [COMFYUI_PLUGIN_ID]: "enabled" });
        const config: AiConfig = {
            ...defaultConfig,
            taskWorkflowProvider: "comfyui",
            comfyUI: {
                enabled: true,
                baseUrl: "http://comfyui.test:8188",
                apiKey: "comfyui-api-key",
                selectedWorkflowId: "workflow-1",
                workflows: [{ workflowId: "workflow-1", title: "Image workflow", capability: "image", workflowJson: {}, fields: [] }],
            },
        };

        await expect(prepareBackendGenerationTask({ mode: "video", prompt: "A moving scene", config })).rejects.toThrow("当前节点是视频生成");
    });
});
