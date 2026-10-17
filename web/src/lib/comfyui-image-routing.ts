type ImageRoutableWorkflow = { workflowId: string; capability: string; imageEditWorkflowId?: string };

// A pair has one public model identity; either saved file resolves to that identity.
export function comfyUIModelWorkflow<T extends ImageRoutableWorkflow>(workflows: readonly T[], workflowId: string): T | undefined {
    const selected = workflows.find((item) => item.workflowId.trim() === workflowId.trim());
    if (selected?.capability !== "image") return selected;
    return workflows.find((item) => item.capability === "image" && item.imageEditWorkflowId === selected.workflowId) || selected;
}

export function comfyUIModelWorkflows<T extends ImageRoutableWorkflow>(workflows: readonly T[]): T[] {
    return workflows.filter((item) => comfyUIModelWorkflow(workflows, item.workflowId) === item);
}

export function comfyUIWorkflowForInput<T extends ImageRoutableWorkflow>(workflows: readonly T[], workflowId: string, imageCount = 0): T | undefined {
    const model = comfyUIModelWorkflow(workflows, workflowId);
    if (model?.capability !== "image" || !model.imageEditWorkflowId || imageCount === 0) return model;
    return workflows.find((item) => item.workflowId === model.imageEditWorkflowId && item.capability === "image");
}

export function comfyUIImageRoutingError(workflows: readonly ImageRoutableWorkflow[]): string {
    const used = new Set<string>();
    for (const model of workflows) {
        if (!model.imageEditWorkflowId) continue;
        const edit = workflows.find((item) => item.workflowId === model.imageEditWorkflowId);
        if (!edit) return "有图工作流已不存在，请在 ComfyUI 设置中重新关联";
        if (model.capability !== "image" || edit.capability !== "image") return "自动切换只能关联图片工作流";
        if (edit === model || edit.imageEditWorkflowId) return "图片工作流只能两两关联，不能关联自身或形成多级关联";
        if (used.has(edit.workflowId)) return "同一个有图工作流不能归属多个图片模型";
        used.add(edit.workflowId);
    }
    return "";
}
