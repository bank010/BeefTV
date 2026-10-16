import { http } from "@/services/api/request";
import type { ComfyUIWorkflow, RunningHubCapability } from "@/stores/use-config-store";

export type ComfyUIUserDataItem = {
    name: string;
    type?: string;
    size?: number;
    modified?: number;
};

type ComfyUIRequest = {
    baseUrl: string;
    apiKey: string;
};

export function fetchComfyUIUserData(config: ComfyUIRequest & { directory: string }) {
    return http.post<ComfyUIUserDataItem[]>("/comfyui/userdata", config);
}

export function fetchComfyUIWorkflow(config: ComfyUIRequest & { file: string; capability: RunningHubCapability }) {
    return http.post<ComfyUIWorkflow>("/comfyui/workflow-info", config);
}
