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
