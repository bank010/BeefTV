import { workflowMediaInputLimit, workflowMediaInputLimitForWorkflow } from "@/lib/model-capabilities";
import { comfyUIWorkflowForModel, type AiConfig } from "@/stores/use-config-store";

/**
 * 临时：当前显卡跑 Comfy 全能参考视频工作流时的能力兜底。
 * 工作流字段映射未声明 reference 槽位时，仍允许 9 图 / 3 视频 / 3 音频。
 * 换更强显卡并完善工作流映射后可删除本文件及所有引用。
 */
export const COMFY_OMNI_REFERENCE_MEDIA_LIMITS = {
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
} as const;

/** 上传参考视频时，成片最长秒数（当前 GPU 约束）。 */
export const COMFY_REFERENCE_VIDEO_MAX_OUTPUT_SECONDS = 10;

export function comfyOmniReferenceWorkflowModel(config: Pick<AiConfig, "comfyUI">, model: string) {
    const workflow = comfyUIWorkflowForModel(config, model);
    return workflow?.capability === "video" ? workflow : undefined;
}

export function applyComfyOmniReferenceMediaLimits(
    config: Pick<AiConfig, "comfyUI">,
    model: string,
    limits: { maxImages: number; maxVideos: number; maxAudios: number },
) {
    const workflow = comfyOmniReferenceWorkflowModel(config, model);
    if (!workflow) return limits;
    const fields = workflow.fields || [];
    const json = workflow.workflowJson;
    const sourceJson = workflow.sourceWorkflowJson;
    const imageSources = ["referenceimage", "image", "referenceimages"] as const;
    const videoSources = ["referencevideo", "video", "referencevideos"] as const;
    const audioSources = ["referenceaudio", "audio", "referenceaudios"] as const;
    const mappingDeclares =
        workflowMediaInputLimit(fields, imageSources) +
            workflowMediaInputLimit(fields, videoSources) +
            workflowMediaInputLimit(fields, audioSources) >
        0;
    if (mappingDeclares) return limits;
    const hasMediaTopology =
        workflowMediaInputLimitForWorkflow(fields, json, imageSources, sourceJson) > 0 ||
        workflowMediaInputLimitForWorkflow(fields, json, videoSources, sourceJson) > 0 ||
        workflowMediaInputLimitForWorkflow(fields, json, audioSources, sourceJson) > 0;
    if (!hasMediaTopology) return limits;
    return {
        maxImages: Math.max(limits.maxImages, COMFY_OMNI_REFERENCE_MEDIA_LIMITS.maxImages),
        maxVideos: Math.max(limits.maxVideos, COMFY_OMNI_REFERENCE_MEDIA_LIMITS.maxVideos),
        maxAudios: Math.max(limits.maxAudios, COMFY_OMNI_REFERENCE_MEDIA_LIMITS.maxAudios),
    };
}

export function comfyReferenceVideoDurationError(config: Pick<AiConfig, "comfyUI">, model: string, referenceVideoCount: number, videoSeconds: string | undefined) {
    if (!comfyOmniReferenceWorkflowModel(config, model) || referenceVideoCount <= 0) return "";
    const seconds = Number(videoSeconds);
    if (!Number.isFinite(seconds)) return "";
    if (seconds > COMFY_REFERENCE_VIDEO_MAX_OUTPUT_SECONDS) {
        return `当前显卡配置下，上传参考视频时成片最长 ${COMFY_REFERENCE_VIDEO_MAX_OUTPUT_SECONDS} 秒`;
    }
    return "";
}

export function clampComfyReferenceVideoOutputSeconds(
    config: Pick<AiConfig, "comfyUI">,
    model: string,
    referenceVideoCount: number,
    videoSeconds: string | undefined,
) {
    if (!comfyOmniReferenceWorkflowModel(config, model) || referenceVideoCount <= 0) return videoSeconds;
    const seconds = Number(videoSeconds);
    if (!Number.isFinite(seconds)) return String(COMFY_REFERENCE_VIDEO_MAX_OUTPUT_SECONDS);
    return String(Math.min(seconds, COMFY_REFERENCE_VIDEO_MAX_OUTPUT_SECONDS));
}
