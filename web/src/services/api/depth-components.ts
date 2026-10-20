import { ApiError, http } from "@/services/api/request";
import type { DepthComponentState } from "@/services/desktop-runtime";

async function componentRequest(request: Promise<DepthComponentState>) {
    try {
        return await request;
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
            throw new Error("后端尚未加载深度捕捉组件接口，请重启后端后重试");
        }
        throw error;
    }
}

export function readDepthComponentStatus(refresh = false) {
    return componentRequest(http.get<DepthComponentState>("/depth-components/status", { params: { refresh }, timeout: 30_000 }));
}

export function downloadDepthComponents() {
    return componentRequest(http.post<DepthComponentState>("/depth-components/download", undefined, { timeout: 30_000 }));
}

export function pauseDepthComponentDownload() {
    return componentRequest(http.post<DepthComponentState>("/depth-components/pause", undefined, { timeout: 130_000 }));
}
