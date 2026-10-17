import type { WorkflowVideoFieldLike } from "./model-capabilities";

type WorkflowNode = { class_type?: string; inputs?: Record<string, unknown> };

/** Only expose dimensions on a known output path; reference encoders and inactive branches are not output sizes. */
export function comfyUIOutputDimensions(graph: Record<string, unknown> | undefined, fields: readonly WorkflowVideoFieldLike[] = []) {
    if (!graph) return undefined;
    const node = (id: string) => graph[id] as WorkflowNode | undefined;
    const saved = Object.keys(graph).filter((id) => ["SaveImage", "SaveImageAdvanced"].includes(node(id)?.class_type || ""));
    const outputs = saved.length ? saved : Object.keys(graph).filter((id) => node(id)?.class_type === "PreviewImage");
    if (!outputs.length) return undefined;
    const trace = (link: unknown, stage: "image" | "samples" | "latent", visited = new Set<string>()): string | undefined => {
        if (!Array.isArray(link) || link.length !== 2 || link[1] !== 0) return undefined;
        const id = String(link[0]);
        if (visited.has(id)) return undefined;
        visited.add(id);
        const current = node(id);
        const inputs = current?.inputs;
        if (!inputs) return undefined;
        if (current.class_type === "ComfySwitchNode" && typeof inputs.switch === "boolean") {
            const field = fields.find((item) => item.nodeId === id && item.fieldName === "switch" && item.enabled !== false);
            const value = field ? (field.source ? undefined : field.fieldValue ?? field.value ?? inputs.switch) : inputs.switch;
            return typeof value === "boolean" ? trace(inputs[value ? "on_true" : "on_false"], stage, visited) : undefined;
        }
        if (stage === "image" && current.class_type === "VAEDecode") return trace(inputs.samples, "samples", visited);
        if (stage === "samples" && ["KSampler", "KSamplerAdvanced"].includes(current.class_type || "")) return trace(inputs.latent_image, "latent", visited);
        if (stage === "latent" && ["EmptyLatentImage", "EmptySD3LatentImage"].includes(current.class_type || "")) return id;
        return undefined;
    };
    const candidates = outputs.map((id) => trace(node(id)?.inputs?.images, "image"));
    const nodeId = candidates[0];
    if (!nodeId || candidates.some((id) => id !== nodeId)) return undefined;
    const current = node(nodeId)!;
    const dimension = (name: "width" | "height") => {
        const raw = current.inputs?.[name];
        if (typeof raw !== "number") return undefined;
        const field = fields.find((item) => item.nodeId === nodeId && item.fieldName === name);
        if (field?.safeToOverride === false) return undefined;
        const value = field?.enabled !== false && !field?.source ? (field?.fieldValue ?? field?.value ?? raw) : raw;
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value % 8 === 0 ? value : undefined;
    };
    const width = dimension("width");
    const height = dimension("height");
    return width && height ? { nodeId, classType: current.class_type!, width, height, size: `${width}x${height}` } : undefined;
}
