import { afterEach, beforeEach, expect, test } from "bun:test";
import { COMFYUI_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { comfyUIImageRoutingError } from "@/lib/comfyui-image-routing";
import { buildGenerationConfig, resolveCanvasGenerationModel } from "@/lib/canvas/canvas-project-generation";
import { buildNodeConfig } from "@/components/canvas/canvas-node-prompt-panel";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { configuredModelDisplayName, mergedImageCapabilityConfig, modelCompatibilityError, resolveCompatibleModel } from "@/lib/model-selection";
import { prepareBackendGenerationTask, runBackendGenerationTask, runBackendGenerationTaskBatch, submitBackendGenerationTask, type GenerationTaskDependencies } from "@/services/api/generation-task";
import { resourceStorageKey } from "@/services/api/resources";
import { comfyUIWorkflowModel, defaultConfig, normalizeConfigSnapshot, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { CreateTaskInput, GenerationTask } from "@/services/api/task-center";

const originalStatuses = usePluginStore.getState().runtimeStatuses;
beforeEach(() => usePluginStore.getState().setRuntimeStatuses({ ...originalStatuses, [COMFYUI_PLUGIN_ID]: "enabled" }));
afterEach(() => usePluginStore.getState().setRuntimeStatuses(originalStatuses));

const imageModel = comfyUIWorkflowModel("base.json");
const editModel = comfyUIWorkflowModel("edit.json");
function config(): AiConfig {
    const graph = (width: number, height: number) => ({
        "1": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
        "2": { class_type: "KSampler", inputs: { latent_image: ["1", 0] } },
        "3": { class_type: "VAEDecode", inputs: { samples: ["2", 0] } },
        "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    });
    return structuredClone({ ...defaultConfig, channels: [], model: imageModel, imageModel, taskWorkflowProvider: "model", size: "auto", comfyUI: {
        enabled: true, baseUrl: "https://comfy.example", apiKey: "", selectedWorkflowId: "edit.json", workflows: [
            { workflowId: "base.json", title: "Qwen", capability: "image", imageEditWorkflowId: "edit.json", workflowJson: graph(960, 1440), fields: [] },
            { workflowId: "edit.json", title: "Reference branch", capability: "image", workflowJson: { ...graph(1024, 1024), "5": { class_type: "LoadImage", inputs: { image: "saved-default.png" } } }, fields: [{ nodeId: "5", fieldName: "image", source: "referenceImage", enabled: true, safeToOverride: true }] },
        ],
    } });
}
const reference: ReferenceImage = { id: "reference", name: "reference.png", type: "image/png", dataUrl: "", url: "https://media.example/reference.png" };
const inputSummary = (imageCount: number) => ({ imageCount, textCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 });

test("a paired image model has one identity before and after configuration restore", () => {
    const c = config();
    expect(selectableModelsByCapability(c, "image")).toEqual([imageModel]);
    expect(resolveCompatibleModel(c, editModel, { capability: "image", input: inputSummary(1) })).toBe(imageModel);
    expect(resolveCanvasGenerationModel(c, editModel, "image")).toBe(imageModel);
    expect(configuredModelDisplayName(c, editModel)).toBe(configuredModelDisplayName(c, imageModel));
    const restored = normalizeConfigSnapshot({ config: { ...c, model: editModel, imageModel: editModel } }).config;
    expect(restored.imageModel).toBe(imageModel);
    expect(restored.comfyUI.workflows[0].imageEditWorkflowId).toBe("edit.json");
    expect(selectableModelsByCapability(restored, "image")).toEqual([imageModel]);
    expect(modelCapabilityConfigFor(c, imageModel).image?.references.maxImages).toBe(1);
    expect(modelCompatibilityError(c, imageModel, { capability: "image", input: inputSummary(1) })).toBe("");
});

test("prepared inputs decide the graph, task identity, fields and capability without mutating saved configuration", async () => {
    const c = config();
    const original = structuredClone(c);
    for (const referenceImages of [[], [reference], [{ ...reference, url: undefined, storageKey: resourceStorageKey("owned-image") }]]) {
        const task = await prepareBackendGenerationTask({ config: c, mode: "image", prompt: "A portrait", referenceImages });
        const edit = referenceImages.length > 0;
        expect(task.provider).toBe("comfyui");
        expect(task.model).toBe(edit ? "ComfyUI · Reference branch" : "ComfyUI · Qwen");
        expect(task.input?.execution?.workflowId).toBe(edit ? "edit.json" : "base.json");
        expect(task.input?.config.workflowId).toBe(task.input?.execution?.workflowId);
        expect(task.input?.config.workflowJson).toEqual(c.comfyUI.workflows[edit ? 1 : 0].workflowJson);
        expect(task.input?.config.size).toBe(edit ? "1024x1024" : "960x1440");
        expect(task.input?.config.capabilityConfig.image.references.maxImages).toBe(edit ? 1 : 0);
        expect(task.input?.referenceImages).toHaveLength(referenceImages.length);
        if (edit) expect(task.input?.config.workflowFields).toContainEqual(c.comfyUI.workflows[1].fields[0]);
    }
    expect(c).toEqual(original);
});

test("canvas input changes drive both displayed dimensions and generation configuration", () => {
    const c = config();
    const node: CanvasNodeData = { id: "output", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { model: imageModel } };
    for (const count of [0, 1, 0]) {
        const requirements = { capability: "image" as const, input: inputSummary(count) };
        const ui = buildNodeConfig(c, node, "image", requirements);
        const execution = buildGenerationConfig(c, node, "image", requirements);
        expect(ui.comfyUI.selectedWorkflowId).toBe(count ? "edit.json" : "base.json");
        expect(execution.comfyUI.selectedWorkflowId).toBe(ui.comfyUI.selectedWorkflowId);
        expect(ui.size).toBe(count ? "1024x1024" : "960x1440");
        expect(execution.size).toBe(ui.size);
        expect(mergedImageCapabilityConfig(c, imageModel, count).size.default).toBe(ui.size);
    }
});

test("submit, run and batch paths use the same reference-driven selection", async () => {
    const inputs: CreateTaskInput[] = [];
    const completed = { id: "task", status: "succeeded", resultJson: JSON.stringify({ mode: "image", images: [] }) } as GenerationTask;
    const dependencies: GenerationTaskDependencies = { createId: () => "id", createTask: async (input) => { inputs.push(input); return completed; }, waitTask: async () => completed };
    const options = { config: config(), mode: "image" as const, prompt: "Edit the input", referenceImages: [reference] };
    await submitBackendGenerationTask(options, dependencies);
    await runBackendGenerationTask(options, dependencies);
    const results = await runBackendGenerationTaskBatch({ ...options, count: 2 }, dependencies);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(inputs).toHaveLength(4);
    expect(inputs.every((input) => input.input?.config.workflowId === "edit.json" && input.input?.referenceImages.length === 1)).toBe(true);
});

test("missing, invalid and unmapped edit branches fail without discarding references", async () => {
    const c = config();
    const prepare = () => prepareBackendGenerationTask({ config: c, mode: "image", prompt: "Edit", referenceImages: [reference] });
    c.comfyUI.workflows.pop();
    await expect(prepare()).rejects.toThrow("有图工作流已不存在");
    c.comfyUI = config().comfyUI;
    c.comfyUI.workflows[1].capability = "video";
    await expect(prepare()).rejects.toThrow("只能关联图片工作流");
    c.comfyUI = config().comfyUI;
    c.comfyUI.workflows[1].fields[0].enabled = false;
    await expect(prepare()).rejects.toThrow("没有参考图输入");
    c.comfyUI = config().comfyUI;
    c.comfyUI.workflows[1].fields[0].safeToOverride = false;
    await expect(prepare()).rejects.toThrow("没有参考图输入");
    c.comfyUI = config().comfyUI;
    c.comfyUI.workflows[1].fields = [];
    expect(modelCapabilityConfigFor(c, imageModel).image?.references.maxImages).toBe(0);
    expect(modelCapabilityConfigFor(c, imageModel, 1).image?.references.maxImages).toBe(0);
    await expect(prepare()).rejects.toThrow("没有参考图输入");
    c.comfyUI = config().comfyUI;
    await expect(prepareBackendGenerationTask({ config: c, mode: "image", prompt: "Edit", referenceImages: [reference, { ...reference, id: "second" }] })).rejects.toThrow("最多支持 1 张参考图");
    c.comfyUI.workflows[1].imageEditWorkflowId = "base.json";
    expect(comfyUIImageRoutingError(c.comfyUI.workflows)).toContain("不能关联自身或形成多级关联");
    c.comfyUI = config().comfyUI;
    c.comfyUI.workflows.push({ ...c.comfyUI.workflows[0], workflowId: "duplicate-owner.json" });
    expect(comfyUIImageRoutingError(c.comfyUI.workflows)).toContain("不能归属多个图片模型");
});
