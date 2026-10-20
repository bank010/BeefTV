import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel, videoSizeLabel } from "../src/components/video-settings-panel";
import { canvasThemes } from "../src/lib/canvas-theme";
import { defaultConfig, normalizeConfigSnapshot, normalizeWorkflowFieldMappings } from "../src/stores/use-config-store";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-config";
import { modelCapabilityConfigFor, resolveVideoResolutionValue } from "../src/lib/model-capabilities";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { usePluginStore } from "../src/stores/use-plugin-store";
import { COMFYUI_PLUGIN_ID } from "../src/lib/plugins/builtin/workflows";

test("workflow ratio descriptions keep portrait labels and previews without changing enum values", () => {
    const ratio = "9:16 (Portrait Widescreen)";
    const config = {
        ...defaultConfig,
        model: "comfyui-workflow::video.json",
        size: ratio,
        comfyUI: {
            ...defaultConfig.comfyUI,
            enabled: true,
            workflows: [{ workflowId: "video.json", title: "Video", capability: "video" as const, fields: [
                { nodeId: "115", fieldName: "aspect_ratio", fieldValue: ratio, enabled: true, safeToOverride: true },
            ] }],
        },
    };
    const html = renderToStaticMarkup(<VideoSettingsPanel config={config} theme={canvasThemes.dark} onConfigChange={() => {}} />);
    expect(videoSizeLabel(ratio)).toBe("9:16");
    expect(videoSizeLabel("21:9 (Cinema)")).toBe("21:9");
    expect(videoSizeLabel("custom ratio")).toBe("custom ratio");
    expect(videoSizeLabel("1280x720")).toBe("横屏");
    expect(html).toContain("width:9px;height:16px");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">9:16</span>");
    expect(html).toContain("由工作流决定");
    expect(config.size).toBe(ratio);
});

test("H3 workflow controls retain node selections through task preparation", async () => {
    const workflowId = "video-controls.json";
    const model = `comfyui-workflow::${workflowId}`;
    const fields = [
        { nodeId: "size", classType: "ResolutionSelector", fieldName: "aspect_ratio", fieldValue: "9:16 (Portrait Widescreen)", source: "aspectRatio", sourceAutomatic: true, enabled: true, safeToOverride: true },
        { nodeId: "size", classType: "ResolutionSelector", fieldName: "megapixels", fieldType: "NUMBER", fieldValue: 0.9, source: "vquality", sourceAutomatic: true, min: 0.1, max: 16, step: 0.1, enabled: true, safeToOverride: true },
        { nodeId: "seconds", classType: "PrimitiveFloat", fieldName: "value", fieldType: "NUMBER", fieldValue: 15, source: "videoSeconds", sourceAutomatic: true, min: 1, max: 15, step: 1, enabled: true, safeToOverride: true },
    ];
    const global = { ...defaultConfig, model, videoModel: model, comfyUI: {
        ...defaultConfig.comfyUI, enabled: true, baseUrl: "http://comfyui.test:8188", selectedWorkflowId: workflowId,
        workflows: [{ workflowId, title: "Video controls", capability: "video" as const, fields, workflowJson: {
            size: { class_type: "ResolutionSelector", inputs: { aspect_ratio: "9:16 (Portrait Widescreen)", megapixels: 0.9, multiple: 32 } },
            seconds: { class_type: "PrimitiveFloat", inputs: { value: 15 } },
        } }],
    } };
    const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model } };
    // Match workspace hydration, including repeated normalization on store restore.
    const restored = normalizeConfigSnapshot({ config: normalizeConfigSnapshot({ config: global }).config }).config;
    expect(restored.comfyUI.workflows[0].fields.map((field) => field.source)).toEqual(["aspectRatio", "vquality", "videoSeconds"]);
    const defaults = buildGenerationConfig(restored, node, "video");
    expect(defaults).toMatchObject({ size: "9:16 (Portrait Widescreen)", videoSeconds: "15", vquality: "0.9" });
    const config = buildGenerationConfig(restored, { ...node, metadata: { model, size: "16:9 (Widescreen)", seconds: "8", vquality: "1.2" } }, "video");
    expect(config).toMatchObject({ size: "16:9 (Widescreen)", videoSeconds: "8", vquality: "1.2" });
    const profile = modelCapabilityConfigFor(config, model).video!;
    expect(profile.ratios).toHaveLength(8);
    expect(profile.duration.values).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(profile.resolutionRange).toEqual({ min: 0.1, max: 16, step: 0.1, unit: "MP" });
    expect(resolveVideoResolutionValue(profile, "1.2")).toBe("1.2");
    expect(resolveVideoResolutionValue(profile, "1080p")).toBe("0.9");
    for (const theme of [canvasThemes.dark, canvasThemes.light]) {
        const html = renderToStaticMarkup(<VideoSettingsPanel config={config} theme={theme} onConfigChange={() => {}} />);
        expect(html).toContain('aria-label="视频分辨率（MP）"');
        expect(html).toContain('value="1.2"');
        expect(html).toContain('>1.2 MP</button>');
        expect(html).toContain('>8s</button>');
        expect(html).toContain('>16:9</span>');
        expect(html).not.toContain("由工作流决定");
    }
    const statuses = usePluginStore.getState().runtimeStatuses;
    try {
        usePluginStore.getState().setRuntimeStatuses({ ...statuses, [COMFYUI_PLUGIN_ID]: "enabled" });
        const task = await prepareBackendGenerationTask({ mode: "video", prompt: "moving scene", config });
        expect(task.input?.config).toMatchObject({ size: "16:9 (Widescreen)", videoSeconds: "8", vquality: "1.2", workflowFields: restored.comfyUI.workflows[0].fields });
        expect(task.input?.config.workflowJson).toEqual(global.comfyUI.workflows[0].workflowJson);
    } finally {
        usePluginStore.getState().setRuntimeStatuses(statuses);
    }
});

test("automatic video bindings remain independent when multiple fields share a source", () => {
    const field = { nodeId: "one", classType: "PrimitiveFloat", fieldName: "value", source: "videoSeconds", sourceAutomatic: true, min: 1, max: 15, step: 1, fieldValue: 5 };
    expect(normalizeWorkflowFieldMappings([field, { ...field, nodeId: "two", fieldValue: 10 }], "video").map((item) => [item.source, item.fieldValue])).toEqual([["", 5], ["", 10]]);
    expect(normalizeWorkflowFieldMappings([{ ...field, source: "", sourceAutomatic: false }], "video")[0].source).toBe("");
    expect(normalizeWorkflowFieldMappings([{ ...field, enabled: false }], "video")[0].enabled).toBe(false);
    expect(normalizeWorkflowFieldMappings([{ ...field, safeToOverride: false }], "video")[0].enabled).toBe(false);
});
