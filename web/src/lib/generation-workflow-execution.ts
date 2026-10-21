import { comfyUIWorkflowForModel, normalizeRunningHubCapability, resolveWorkflowFieldsForExecution, type AiConfig, type RunningHubCapability, type RunningHubWorkflowKind, type WorkflowFieldMapping } from "@/stores/use-config-store";
import { comfyUIImageRoutingError, comfyUIWorkflowForInput } from "@/lib/comfyui-image-routing";
import { workflowMediaInputLimit } from "@/lib/model-capabilities";
import { workflowProviderPluginEnabled } from "@/lib/plugins/builtin/workflows";
import { usePluginStore } from "@/stores/use-plugin-store";

export type GenerationWorkflowMode = "text" | "image" | "video" | "audio";

export type GenerationWorkflowExecution = {
	provider: "runninghub" | "comfyui";
    kind: RunningHubWorkflowKind;
    capability: RunningHubCapability;
    interfaceType: string;
    name: string;
    taskModel: string;
    providerModel: string;
    workflowId: string;
    webappId: string;
    workflowJson: Record<string, unknown>;
    sourceWorkflowJson?: Record<string, unknown>;
    workflowFields: WorkflowFieldMapping[];
};

// 画布样式计划、任务记录和后端协议必须共用同一个工作流选择结果，避免再次回退到普通模型。
export function resolveGenerationWorkflowExecution(config: AiConfig, mode: GenerationWorkflowMode, imageCount = 0): GenerationWorkflowExecution | null {
    const modelWorkflow = comfyUIWorkflowForModel(config, config.model);
    const workflowProvider = mode === "text" ? "model" : modelWorkflow ? "comfyui" : config.taskWorkflowProvider || "model";
    if (workflowProvider === "model") return null;

    if (workflowProvider === "runninghub") {
        if (!workflowProviderPluginEnabled(usePluginStore.getState().runtimeStatuses, "runninghub")) throw new Error("RunningHub 工作流插件未启用");
        const runningHub = config.runningHub;
        const workflowId = runningHub.workflowId.trim();
        const kind = runningHub.selectedKind === "app" ? "app" : "workflow";
        // RunningHub 工作流的参数拉取、提交和轮询固定使用积分 API Key；企业级 Key 只用于素材上传。
        const apiKey = runningHub.apiKey;
        if (!runningHub.enabled || !runningHub.baseUrl.trim() || !apiKey.trim() || !workflowId) {
            throw new Error("RunningHub 工作流配置不完整，请填写积分 API Key 并选择已保存条目");
        }
        const workflow = runningHub.workflows.find((item) => item.workflowId.trim() === workflowId && (item.kind === "app" ? "app" : "workflow") === kind);
        if (!workflow) throw new Error("当前 RunningHub 工作流条目不存在，请重新选择已保存条目");
        const capability = normalizeRunningHubCapability(workflow.capability, normalizeRunningHubCapability(runningHub.capability));
        assertWorkflowCapability("RunningHub", capability, mode);
        const webappId = kind === "app" ? (workflow.webappId || workflow.workflowId).trim() : "";
        const name = workflow.title?.trim() || webappId || workflowId;
        return {
            provider: "runninghub",
            kind,
            capability,
            interfaceType: `runninghub-workflow-${capability}`,
            name,
            taskModel: workflowTaskModel("RunningHub · ", name),
            providerModel: workflowId,
            workflowId: kind === "workflow" ? workflowId : "",
            webappId,
            workflowJson: workflow.workflowJson || {},
            workflowFields: resolveWorkflowFieldsForExecution(workflow),

		};
	}

	if (workflowProvider === "comfyui") {
		if (!workflowProviderPluginEnabled(usePluginStore.getState().runtimeStatuses, "comfyui")) throw new Error("ComfyUI 工作流插件未启用");
		const comfyUI = config.comfyUI;
		const selectedId = modelWorkflow?.workflowId || comfyUI.selectedWorkflowId.trim();
		if (!comfyUI.enabled || !comfyUI.baseUrl.trim() || !selectedId) throw new Error("ComfyUI 工作流配置不完整，请填写 Base URL 并选择已保存工作流");
        if (mode === "image") {
            const routingError = comfyUIImageRoutingError(comfyUI.workflows);
            if (routingError) throw new Error(routingError);
        }
		const workflow = comfyUIWorkflowForInput(comfyUI.workflows, selectedId, mode === "image" ? imageCount : 0);
		if (!workflow) throw new Error("当前 ComfyUI 工作流不存在，请重新选择已保存工作流");
		const workflowId = workflow.workflowId;
		const capability = normalizeRunningHubCapability(workflow.capability);
		assertWorkflowCapability("ComfyUI", capability, mode);
        if (mode === "image" && imageCount > 0) {
            const maxImages = workflowMediaInputLimit(workflow.fields, ["referenceimage", "image", "referenceimages"]);
            if (!maxImages) throw new Error("当前图片工作流没有参考图输入，请在 ComfyUI 设置中关联有图工作流");
            if (imageCount > maxImages) throw new Error(`当前图片工作流最多支持 ${maxImages} 张参考图，实际传入 ${imageCount} 张`);
        }
		const name = workflow.title.trim() || workflowId;
		return {
			provider: "comfyui",
			kind: "workflow",
			capability,
			interfaceType: `comfyui-workflow-${capability}`,
			name,
			taskModel: workflowTaskModel("ComfyUI · ", name),
			providerModel: workflowId,
			workflowId,
			webappId: "",
			workflowJson: workflow.workflowJson || {},
			sourceWorkflowJson: workflow.sourceWorkflowJson,
			workflowFields: resolveWorkflowFieldsForExecution(workflow),
		};
	}

	throw new Error("未知工作流提供方");
}

function assertWorkflowCapability(providerName: string, capability: RunningHubCapability, mode: GenerationWorkflowMode) {
    if (capability === mode) return;
    const capabilityName = workflowCapabilityName(capability);
    const modeName = workflowCapabilityName(mode);
    throw new Error(`${providerName} 已保存条目的用途为${capabilityName}，当前节点是${modeName}生成，请切换匹配的工作流`);
}

function workflowCapabilityName(value: GenerationWorkflowMode) {
    if (value === "video") return "视频";
    if (value === "audio") return "音频";
    if (value === "text") return "文本";
    return "图片";
}

function workflowTaskModel(prefix: string, name: string) {
    return `${prefix}${Array.from(name)
        .slice(0, Math.max(0, 120 - prefix.length))
        .join("")}`;
}
