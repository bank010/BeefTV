import { canReloadCanvasGenerationResult } from "@/lib/canvas/canvas-generation-recovery";
import { isCanvasNodeActivelyGenerating, isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { createClientId } from "@/lib/client-id";
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";

import { buildNodeGenerationContext, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { isGenerationCanceled, resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { buildConfirmedGenerationConfig } from "./canvas-assistant-proposal-execution";
import type { ConfirmedGenerationInputs } from "./canvas-assistant-proposal-snapshot";
import { canvasGenerationPromptMetadata, canvasGenerationRequestFingerprint, runCanvasGenerationSubmissionOnce } from "@/lib/canvas/canvas-generation-submission";
import { resolvedCanvasGenerationRequirements } from "@/lib/canvas/canvas-generation-config";
import { isGenerationTaskCapacityError } from "@/lib/canvas/canvas-generation-batch";
import { buildPortraitTexturePrompt } from "@/lib/canvas/canvas-portrait-texture";
import { buildCameraPrompt } from "@/lib/canvas/camera-prompt-library";
import { buildTextRewritePrompt } from "@/lib/prompts";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { generationErrorMessage } from "@/lib/generation-error";
import { navigateToSettings } from "@/lib/settings-navigation";
import { modelCompatibilityError, modelGroupReferenceLimits, modelPromptLengthError, modelRequestOptions, type ModelRequirements } from "@/lib/model-selection";
import type { Skill } from "@/services/api/skills";
import { skillRuntime } from "@/services/skill-runtime";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { findGenerationTaskByOperation, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { comfyUIWorkflowForModel, useConfigStore, useEffectiveConfig, resolveModelRequestConfig } from "@/stores/use-config-store";
import { clampComfyReferenceVideoOutputSeconds, COMFY_OMNI_REFERENCE_MEDIA_LIMITS } from "@/lib/comfy-omni-reference-temp-limit";
import { seedanceReferenceRatioWarning } from "@/lib/seedance-channel-warning";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

import { executeImageGeneration } from "./canvas-image-generation-executor";
import { executeAudioGeneration, executeVideoGeneration } from "./canvas-media-generation-executors";
import { executeTextGeneration } from "./canvas-text-generation-executor";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, canvasImageGenerationHasPendingResult, canvasImagePendingResultMessage } from "./canvas-generation-failure";
import { createReferenceLinkResolver } from "@/components/generation-reference-links";
import { confirmCanvasGeneration, waitForCanvasPreparation } from "./canvas-generation-preflight";

type UseCanvasGenerationExecutorOptions = {
    projectId: string;
    domainProjectId?: string;
    addedSkills: Skill[];
    assets: Asset[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
    applyGenerationTaskResult: (targetNodeId: string, task: GenerationTask) => Promise<void>;
    isLiveRequestNode?: (nodeId: string) => boolean;
};

const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export type CanvasNodeGenerationOptions = {
    confirmedModelKey?: string;
    confirmedInputs?: ConfirmedGenerationInputs;
    /** 一次确认的稳定身份。重复提交必须复用，服务端据此回读原任务。 */
    clientOperationId?: string;
    controller?: AbortController;
    waitForTaskCapacity?: boolean;
    context?: { conversationId?: string; messageId?: string };
    retryContext?: { retryOf: string; attemptGroupId: string; clientOperationId: string };
    onTaskUpdate?: (task: GenerationTask) => void;
    onSubmissionPlan?: (manifest: import("@/services/api/assistant-continuation").AssistantSubmissionManifest) => Promise<void>;
    skipDuplicateConfirmation?: boolean;
};

export function useCanvasGenerationExecutor({
    projectId,
    domainProjectId,
    addedSkills,
    assets,
    nodesRef,
    connectionsRef,
    setNodes,
    setConnections,
    setSelectedNodeIds,
    setSelectedConnectionId,
    setDialogNodeId,
    setRunningNodeId,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
    isLiveRequestNode = () => false,
}: UseCanvasGenerationExecutorOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const submissionLocksRef = useRef(new Map<string, Promise<unknown>>());
    const confirmDuplicateSubmission = useCallback(
        (signal: AbortSignal) =>
            confirmCanvasGeneration((callbacks) => modal.confirm({
                    title: "再次生成相同内容？",
                    content: "当前节点已使用相同提示词、模型、参数和参考素材提交过任务。再次生成会新建任务，并可能再次消耗积分。",
                    okText: "仍然生成",
                    cancelText: "取消",
                    centered: true,
                    zIndex: 3000,
                    ...callbacks,
                }), signal),
        [modal],
    );

    return useCallback(
        (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options?: CanvasNodeGenerationOptions) => {
            return runCanvasGenerationSubmissionOnce(
                submissionLocksRef.current,
                nodeId,
                async () => {
                    let stage = "validation";
                    const attemptId = createClientId();
                    let preparing = false;
                    let selectedModel = options?.confirmedModelKey || "";
                    let refSummary = "";
                    const startedAt = performance.now();
                    const diagnostic = (code: string, level: "info" | "warning" | "error" = "info", detail = "") => {
                        const meta = [ `mode=${mode}`, selectedModel ? `model=${selectedModel}` : "", refSummary, detail ].filter(Boolean).join(" ");
                        recordDiagnosticEvent({
                            category: "action", level, code, reason: stage, canvasId: projectId, requestId: attemptId,
                            message: meta ? `画布生成提交：${code} (${meta})` : `画布生成提交：${code}`, durationMs: Math.round(performance.now() - startedAt),
                        });
                    };
                    diagnostic("generation_submit_started");
                    const controller = options?.controller ?? new AbortController();
                    const preparationMessageKey = `canvas-generation-preparation-${nodeId}`;
                    const submissionToastKey = `canvas-generation-submit-${nodeId}`;
                    setRunningNodeId(nodeId);
                    message.loading({ key: submissionToastKey, content: "正在启动生成…", duration: 0 });
                    const reportError = (error: unknown) => {
                        if (controller.signal.aborted || isGenerationCanceled(error)) return;
                        const errText = generationErrorMessage(error);
                        diagnostic(error instanceof Error && error.name === "CanvasPreparationTimeoutError" ? "generation_preflight_timeout" : "generation_preflight_failed", "error", errText);
                        message.error(errText);
                    };
                    try {
                        controller.signal.throwIfAborted();
                        const frozen = structuredClone(options?.confirmedInputs ?? { nodes: nodesRef.current, connections: connectionsRef.current, config: effectiveConfig, assets, skills: addedSkills });
                        const inputNodes = frozen.nodes;
                        const inputConnections = frozen.connections;
                        const inputConfig = frozen.config;
                        const inputAssets = frozen.assets;
                        const inputSkills = frozen.skills;
                        const sourceNode = inputNodes.find((node) => node.id === nodeId);
                        const staleSubmissionIds = new Set(
                            nodesRef.current
                                .filter(
                                    (node) =>
                                        (node.id === nodeId || node.metadata?.generatedFromNodeId === nodeId) &&
                                        ["submitting", "unknown"].includes(node.metadata?.generationSubmissionState || "") &&
                                        !isLiveRequestNode(node.id),
                                )
                                .map((node) => node.id),
                        );
                        if (staleSubmissionIds.size) {
                            const clearedNodes = nodesRef.current.map((node) => {
                                if (!staleSubmissionIds.has(node.id)) return node;
                                const metadata = { ...node.metadata };
                                delete metadata.generationSubmissionState;
                                delete metadata.taskClientOperationId;
                                if (metadata.taskStage === "正在提交生成任务" || metadata.taskStage === "提交结果待确认，请查询原任务") {
                                    delete metadata.taskStage;
                                }
                                if (metadata.status === NODE_STATUS_LOADING && !metadata.taskId) {
                                    metadata.status = NODE_STATUS_IDLE;
                                }
                                return { ...node, metadata };
                            });
                            nodesRef.current = clearedNodes;
                            setNodes(clearedNodes);
                            diagnostic("generation_stale_submission_cleared", "warning");
                        }
                        const pendingSubmissions = nodesRef.current.filter(
                            (node) =>
                                (node.id === nodeId || node.metadata?.generatedFromNodeId === nodeId) &&
                                ["submitting", "unknown"].includes(node.metadata?.generationSubmissionState || "") &&
                                isLiveRequestNode(node.id),
                        );
                        if (pendingSubmissions.length) {
                            const scope = captureUserScope();
                            startGenerationRequest(nodeId, nodeId, nodeId, controller);
                            let recoveredCount = 0;
                            for (const target of pendingSubmissions) {
                                const operationId = target.metadata?.taskClientOperationId?.trim();
                                if (!operationId) {
                                    message.warning("上次提交缺少任务标识，无法查询原任务");
                                    continue;
                                }
                                const task = await findGenerationTaskByOperation(operationId, projectId, controller.signal);
                                controller.signal.throwIfAborted();
                                assertUserScope(scope);
                                if (!task) {
                                    message.warning("尚未查到上次提交的任务，将清除占位状态并重新提交");
                                    continue;
                                }
                                recoveredCount += 1;
                                bindGenerationTask(target.id, task);
                                const completed = await waitForGenerationTask(task.id, { signal: controller.signal, expectedScope: scope, initialTask: task, onTaskUpdate: (update) => bindGenerationTask(target.id, update) });
                                controller.signal.throwIfAborted();
                                assertUserScope(scope);
                                await applyGenerationTaskResult(target.id, completed);
                            }
                            if (recoveredCount > 0) {
                                return;
                            }
                            const staleIds = new Set(pendingSubmissions.map((node) => node.id));
                            setNodes((current) =>
                                current.map((node) => {
                                    if (!staleIds.has(node.id)) return node;
                                    const metadata = { ...node.metadata };
                                    delete metadata.generationSubmissionState;
                                    delete metadata.taskClientOperationId;
                                    if (metadata.taskStage === "正在提交生成任务" || metadata.taskStage === "提交结果待确认，请查询原任务") {
                                        delete metadata.taskStage;
                                    }
                                    return { ...node, metadata };
                                }),
                            );
                            diagnostic("generation_stale_submission_cleared", "warning");
                        }
                        if (mode === "image" && canvasImageGenerationHasPendingResult(sourceNode, inputNodes)) {
                            diagnostic("generation_pending_result", "warning");
                            message.warning(canvasImagePendingResultMessage(sourceNode, inputNodes));
                            return;
                        }
                        const liveSourceNode = nodesRef.current.find((node) => node.id === nodeId);
                        if (isCanvasNodeActivelyGenerating(liveSourceNode, undefined, isLiveRequestNode)) {
                            diagnostic("generation_task_active", "warning");
                            message.info("该节点的生成任务仍在进行中，请等待完成后再生成");
                            return;
                        }
                        if (isCanvasNodeGenerating(liveSourceNode) && canReloadCanvasGenerationResult(liveSourceNode?.metadata)) {
                            diagnostic("generation_result_reload_pending", "warning");
                            message.warning("上一条生成已完成，但结果还没写进节点。请打开任务详情点击「继续取回」，不要重复提交以免再次扣费。");
                            return;
                        }
                        if (sourceNode?.type === CanvasNodeType.Video && sourceNode.metadata?.videoEditOperation === "concat") {
                            diagnostic("generation_concat_source", "warning");
                            message.info("合并成片节点不直接重新生成，请重新选择源视频合并");
                            return;
                        }
                        let generationConfig: ReturnType<typeof buildConfirmedGenerationConfig>;
                        try {
                            generationConfig = buildConfirmedGenerationConfig(inputConfig, sourceNode, mode, undefined, options?.confirmedModelKey);
                            selectedModel = generationConfig.model;
                        } catch (error) {
                            reportError(error);
                            return;
                        }
                        const hasLiveBatchChildren =
                            sourceNode?.type === CanvasNodeType.Image && (sourceNode.metadata?.batchChildIds || []).some((childId) => inputNodes.some((node) => node.id === childId && node.metadata?.batchRootId === sourceNode.id));
                        const hasStaleImageBatchState =
                            mode === "image" && sourceNode?.type === CanvasNodeType.Image && !sourceNode.metadata?.content && Boolean(sourceNode.metadata?.isBatchRoot || sourceNode.metadata?.batchChildIds?.length) && !hasLiveBatchChildren;
                        if (hasStaleImageBatchState) {
                            setNodes((current) =>
                                current.map((node) => {
                                    if (node.id !== sourceNode.id) return node;
                                    const metadata = { ...node.metadata };
                                    delete metadata.isBatchRoot;
                                    delete metadata.batchChildIds;
                                    delete metadata.primaryImageId;
                                    delete metadata.imageBatchExpanded;
                                    delete metadata.batchUsesReferenceImages;
                                    return { ...node, metadata };
                                }),
                            );
                        }
                        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                            diagnostic("generation_config_missing", "warning");
                            message.warning("当前模型或工作流配置不完整，请先在设置中补全后再生成");
                            navigateToSettings({ continueCreation: true });
                            return;
                        }

                        const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
                        const editingTextNode = mode === "text" && Boolean(sourceTextContent);
                        let generationPrompt = mode === "image" && sourceNode?.metadata?.portraitTexture ? buildPortraitTexturePrompt(prompt, sourceNode.metadata.portraitTexture) : prompt;
                        if (mode === "image" && sourceNode?.metadata?.cameraControl?.enabled) {
                            const cameraControl = sourceNode.metadata.cameraControl;
                            const cameraPrompt = buildCameraPrompt({ cameraId: cameraControl.camera, lensId: cameraControl.lens, focalLengthMm: cameraControl.focalLength, apertureF: cameraControl.aperture });
                            generationPrompt = `${generationPrompt}\n${cameraPrompt}`;
                        }
                        const isPreparingEmptyImage = mode === "image" && sourceNode?.type === CanvasNodeType.Image && !sourceNode.metadata?.content;

                        let rawGenerationContext: Awaited<ReturnType<typeof hydrateNodeGenerationContext>>;
                        startGenerationRequest(nodeId, nodeId, nodeId, controller);
                        preparing = true;
                        setRunningNodeId(nodeId);
                        message.loading({ key: preparationMessageKey, content: "正在准备参考素材…", duration: 0 });
                        stage = "references";
                        diagnostic("generation_preflight_stage");
                        // AutoDL/其他声明式视频协议需要结构化参考素材；只有普通
                        // 模型视频接口才把提示词视为纯文本输入。
                        const usesWorkflowProvider = Boolean(mode !== "text" && generationConfig.taskWorkflowProvider && generationConfig.taskWorkflowProvider !== "model");
                        const usesComfyUIModel = Boolean(generationConfig.taskWorkflowProvider === "comfyui" && comfyUIWorkflowForModel(generationConfig, generationConfig.model));
                        // ComfyUI 的浏览器缓存可能来自 API graph；被 bypass 的可选媒体
                        // loader 不在 graph 中，因此不能用缓存里的 0 槽位在提交前拦截。
                        // 后端会读取当前源工作流并按真实槽位做最终校验。
                        const usesModelCapability = !usesWorkflowProvider;
                        // 普通视频协议只保留输入框文本（显式 @文本 引用仍会展开为真实内容）；声明式工作流还要保留连接媒体。
                        const promptOnly = mode === "video" && !usesWorkflowProvider;
                        try {
                            const baseContext = buildNodeGenerationContext(
                                nodeId,
                                inputNodes,
                                inputConnections,
                                editingTextNode ? buildTextRewritePrompt(sourceTextContent, prompt) : generationPrompt,
                                inputAssets,
                                promptOnly,
                            );
                            const requirements = generationModelRequirements(mode, baseContext, sourceNode, generationConfig, true);
                            if (requirements?.input) {
                                const { imageCount = 0, videoCount = 0, audioCount = 0, characterCount = 0 } = requirements.input;
                                refSummary = `refs=i:${imageCount},v:${videoCount},a:${audioCount},c:${characterCount}`;
                            }
                            generationConfig = buildConfirmedGenerationConfig(inputConfig, sourceNode, mode, requirements, options?.confirmedModelKey);
                            selectedModel = generationConfig.model;
                            const compatibilityError = usesModelCapability ? modelCompatibilityError(generationConfig, generationConfig.model, requirements) : "";
                            if (compatibilityError) throw new Error(`当前模型无法支持这组输入和参数：${compatibilityError}`);
                            const referenceLimits = usesComfyUIModel
                                ? COMFY_OMNI_REFERENCE_MEDIA_LIMITS
                                : usesModelCapability
                                  ? modelGroupReferenceLimits(inputConfig, generationConfig.model, mode, requirements)
                                  : undefined;
                            rawGenerationContext = await waitForCanvasPreparation(() => hydrateNodeGenerationContext(baseContext, projectId, domainProjectId, mode, mode === "video" && Boolean(referenceLimits?.maxAudios), !promptOnly, referenceLimits), controller.signal);
                            const hydratedRequirements = generationModelRequirements(mode, rawGenerationContext, sourceNode, generationConfig);
                            if (hydratedRequirements?.input) {
                                const { imageCount = 0, videoCount = 0, audioCount = 0, characterCount = 0 } = hydratedRequirements.input;
                                refSummary = `refs=i:${imageCount},v:${videoCount},a:${audioCount},c:${characterCount}`;
                            }
                            generationConfig = buildConfirmedGenerationConfig(inputConfig, sourceNode, mode, hydratedRequirements, options?.confirmedModelKey);
                            selectedModel = generationConfig.model;
                            const hydratedCompatibilityError = usesModelCapability ? modelCompatibilityError(generationConfig, generationConfig.model, hydratedRequirements) : "";
                            if (hydratedCompatibilityError) throw new Error(`当前模型无法支持这组输入和参数：${hydratedCompatibilityError}`);
                        } catch (error) {
                            reportError(error);
                            return;
                        }

                        let skillExecution: Awaited<ReturnType<typeof skillRuntime.prepare<"canvas">>>;
                        stage = "skills";
                        diagnostic("generation_preflight_stage");
                        try {
                            skillExecution = await waitForCanvasPreparation(() => skillRuntime.prepare({ profile: "canvas", prompt: rawGenerationContext.prompt, skills: inputSkills }), controller.signal);
                        } catch (error) {
                            reportError(error);
                            return;
                        }
                        let effectivePrompt = skillExecution.prompt.trim();
                        stage = "parameters";
                        let styleMetadata = {};
                        if (mode === "image") {
                            try {
                                const styleRuntime = resolveCanvasStyleExecution(inputNodes, sourceNode, effectivePrompt, generationConfig, mode);
                                if (styleRuntime) {
                                    effectivePrompt = styleRuntime.prompt;
                                    styleMetadata = { styleProfileJson: styleRuntime.profileJson, styleExecutionPlan: styleRuntime.plan };
                                }
                            } catch (error) {
                                reportError(error);
                                return;
                            }
                        }
                        const promptLengthError = mode === "video" ? modelPromptLengthError(generationConfig, generationConfig.model, mode, effectivePrompt) : "";
                        if (promptLengthError) {
                            reportError(new Error(promptLengthError));
                            return;
                        }
                        const generationContext = { ...rawGenerationContext, prompt: effectivePrompt };
                        if (canvasGenerationRetryBlocked(sourceNode?.metadata, { ...generationContext, mode })) {
                            diagnostic("generation_retry_blocked", "warning");
                            const retryMessage = sourceNode?.metadata?.taskStage === "submission_unknown"
                                ? "原任务仍在查询中，已阻止重复提交。请点击“查看原任务”或“取回结果”，确认任务结束后再生成。"
                                : sourceNode?.metadata?.errorDetails || "请先查看失败原因并调整输入，再重新生成";
                            message.warning(retryMessage);
                            return;
                        }
                        if (mode === "audio" && generationContext.characterReferences.length) {
                            if (generationContext.characterReferences.length !== 1) {
                                reportError(new Error("角色配音一次只能引用一个角色卡"));
                                return;
                            }
                            const voice = generationContext.resolvedCharacterVoices[0];
                            if (!voice) {
                                reportError(new Error("角色尚未绑定可用声音，无法创建角色配音任务"));
                                return;
                            }
                            generationConfig = { ...generationConfig, audioVoice: voice.voiceKey, audioInstructions: [voice.instructions, generationConfig.audioInstructions].filter(Boolean).join("；") };
                        }
                        if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                            reportError(new Error("请输入生成内容"));
                            return;
                        }

                        const requestFingerprint = canvasGenerationRequestFingerprint({
                            nodeId,
                            mode,
                            prompt: effectivePrompt,
                            model: generationConfig.model,
                            options: modelRequestOptions(generationConfig, mode),
                            workflow:
                                generationConfig.taskWorkflowProvider && generationConfig.taskWorkflowProvider !== "model"
                                    ? {
                                          provider: generationConfig.taskWorkflowProvider,
                                          workflowId: generationConfig.runningHub.workflowId,
                                          workflowKind: generationConfig.runningHub.selectedKind,
                                          parameters: sourceNode?.metadata?.workflowParameters,
                                      }
                                    : undefined,
                            operation: sourceNode?.metadata?.videoEditOperation,
                            audioInstructions: generationConfig.audioInstructions,
                            promptTemplateOperation: sourceNode?.metadata?.promptTemplateOperation,
                            promptTemplateVariables: sourceNode?.metadata?.promptTemplateVariables,
                            context: generationContext,
                        });
                        const duplicateConfirmationRequired =
                            !options?.skipDuplicateConfirmation &&
                            !options?.retryContext &&
                            sourceNode?.metadata?.lastGenerationRequestFingerprint === requestFingerprint &&
                            sourceNode?.metadata?.generationSubmissionState === "accepted" &&
                            sourceNode?.metadata?.taskStatus !== "failed" &&
                            sourceNode?.metadata?.status !== "error" &&
                            !sourceNode?.metadata?.errorDetails;
                        message.destroy(preparationMessageKey);
                        stage = "duplicate_confirmation";
                        if (duplicateConfirmationRequired) {
                            diagnostic("generation_confirmation_waiting");
                            if (!(await confirmDuplicateSubmission(controller.signal))) {
                                diagnostic("generation_confirmation_cancelled");
                                message.info("已取消生成");
                                return;
                            }
                        }

                        const ratioWarning = mode === "video" && !usesWorkflowProvider ? seedanceReferenceRatioWarning({
                            ...resolveModelRequestConfig(generationConfig, generationConfig.model),
                            videoCount: generationContext.referenceVideos.length,
                            ratio: generationConfig.size,
                            operation: sourceNode?.metadata?.videoEditOperation,
                        }) : undefined;
                        if (ratioWarning) {
                            stage = "ratio_confirmation";
                            diagnostic("generation_confirmation_waiting");
                            const accepted = await confirmCanvasGeneration((callbacks) => modal.confirm({ ...ratioWarning, centered: true, ...callbacks }), controller.signal);
                            if (!accepted) {
                                diagnostic("generation_confirmation_cancelled");
                                message.info("已取消生成");
                                return;
                            }
                        }

                        if (mode === "video") {
                            const clampedSeconds = clampComfyReferenceVideoOutputSeconds(
                                generationConfig,
                                generationConfig.model,
                                generationContext.referenceVideos.length,
                                generationConfig.videoSeconds,
                            );
                            if (clampedSeconds && clampedSeconds !== generationConfig.videoSeconds) {
                                generationConfig = { ...generationConfig, videoSeconds: clampedSeconds };
                            }
                        }

                        controller.signal.throwIfAborted();
                        stage = "dispatch";
                        diagnostic("generation_dispatch_started");
                        if (isPreparingEmptyImage) {
                            setNodes((current) =>
                                current.map((node) =>
                                    node.id === nodeId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  prompt,
                                                  composerContent: prompt,
                                                  status: NODE_STATUS_LOADING,
                                                  taskStage: "正在准备生成任务",
                                                  taskProgress: 0,
                                                  taskCreatedAt: new Date().toISOString(),
                                                  errorDetails: undefined,
                                                  generationErrorCode: undefined,
                                                  resourceReloadAvailable: undefined,
                                                  failedPromptFingerprint: undefined,
                                                  failedInputFingerprint: undefined,
                                              },
                                          }
                                        : node,
                                ),
                            );
                        }

                        // 已有内容节点只是本次生成的来源；任务状态归新目标所有，不能覆盖已成功结果。
                        const markSourceStatus = !sourceNode?.metadata?.content && !editingTextNode;
                        const hasPreviousResult = Boolean(sourceNode?.metadata?.content || sourceNode?.metadata?.storageKey);
                        const statusPrompt = sourceNode?.type === CanvasNodeType.Config ? effectivePrompt : prompt;
                        const shouldClearSourceFailure =
                            Boolean(sourceNode?.metadata?.errorDetails || sourceNode?.metadata?.taskStatus === "failed" || sourceNode?.metadata?.status === "error") &&
                            (mode === "video" || mode === "audio" || mode === "image");
                        if (markSourceStatus || shouldClearSourceFailure) {
                            const clearedStatus = markSourceStatus ? NODE_STATUS_LOADING : hasPreviousResult ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE;
                            setNodes((current) =>
                                current.map((node) =>
                                    node.id === nodeId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...resetGenerationTaskMetadata(node.metadata, clearedStatus),
                                                  ...(markSourceStatus ? canvasGenerationPromptMetadata(prompt, statusPrompt) : {}),
                                              },
                                          }
                                        : node,
                                ),
                            );
                        }

                        let pendingNodeIds: string[] = [];
                        const execution = {
                            projectId,
                            nodesRef,
                            nodeId,
                            sourceNode,
                            // 收费输入保持确认时的快照；目标节点写回必须使用当前画布。
                            // 另一目标可能已在重复生成确认等待期间完成，不能把整图回滚到旧结果。
                            canvasNodes: nodesRef.current,
                            canvasConnections: connectionsRef.current,
                            prompt,
                            effectivePrompt,
                            generationConfig,
                            generationContext,
                            controller,
                            editingTextNode,
                            styleMetadata,
                            skillMetadata: skillExecution.metadata,
                            taskContext: options?.context,
                            retryContext: options?.retryContext,
                            onSubmissionPlan: options?.onSubmissionPlan,
                                clientOperationId: options?.clientOperationId || options?.retryContext?.clientOperationId || `canvas:${createClientId()}`,
                            setNodes,
                            setConnections,
                            setSelectedNodeIds,
                            setSelectedConnectionId,
                            setDialogNodeId,
                            startGenerationRequest,
                            finishGenerationRequest,
                            bindGenerationTask: (targetNodeId: string, task: GenerationTask) => {
                                recordDiagnosticEvent({ category: "task", level: "info", code: "generation_submission_bound", message: "画布提交已关联生成任务", requestId: attemptId, canvasId: projectId, taskId: task.id });
                                bindGenerationTask(targetNodeId, task);
                                setNodes((current) => {
                                    const source = current.find((node) => node.id === nodeId);
                                    if (!source || source.metadata?.lastGenerationRequestFingerprint === requestFingerprint) return current;
                                    return current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, lastGenerationRequestFingerprint: requestFingerprint } } : node));
                                });
                                options?.onTaskUpdate?.(task);
                            },
                            applyGenerationTaskResult,
                            showError: (content: string) => message.error(content),
                            resolveReferenceLinks: createReferenceLinkResolver(modal),
                            registerPendingNodeIds: (nodeIds: string[]) => {
                                pendingNodeIds = nodeIds;
                            },
                        };

                        try {
                            if (mode === "image") await executeImageGeneration(execution);
                            else if (mode === "video") await executeVideoGeneration(execution);
                            else if (mode === "audio") await executeAudioGeneration(execution);
                            else await executeTextGeneration(execution);
                        } catch (error) {
                            if (isGenerationCanceled(error)) return;
                            const failure = canvasGenerationFailureMetadata(error, { ...generationContext, mode });
                            if (options?.waitForTaskCapacity && isGenerationTaskCapacityError(error)) {
                                setNodes((current) =>
                                    current.map((node) => {
                                        if (node.id !== nodeId && !pendingNodeIds.includes(node.id)) return node;
                                        const metadata = { ...(node.metadata || {}), status: NODE_STATUS_IDLE, errorDetails: undefined };
                                        delete metadata.taskId;
                                        delete metadata.taskStatus;
                                        delete metadata.taskProgress;
                                        delete metadata.taskStage;
                                        delete metadata.taskCreatedAt;
                                        delete metadata.taskUpdatedAt;
                                        delete metadata.taskStartedAt;
                                        delete metadata.taskCompletedAt;
                                        delete metadata.taskDurationMs;
                                        return { ...node, metadata };
                                    }),
                                );
                                return;
                            }
                            message.error(failure.errorDetails);
                            setNodes((current) =>
                                current.map((node) => {
                                    if (node.id !== nodeId && !pendingNodeIds.includes(node.id)) return node;
                                    if (node.id === nodeId && !pendingNodeIds.includes(node.id)) {
                                        if (hasPreviousResult) {
                                            return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined, generationErrorCode: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined } };
                                        }
                                        if (!markSourceStatus) return node;
                                    }
                                    return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, ...failure } };
                                }),
                            );
                        }
                    } catch (error) {
                        reportError(error);
                    } finally {
                        diagnostic(controller.signal.aborted ? "generation_submission_aborted" : "generation_submission_finished");
                        message.destroy(preparationMessageKey);
                        message.destroy(submissionToastKey);
                        finishGenerationRequest(nodeId, controller);
                        setRunningNodeId((current) => (current === nodeId ? null : current));
                    }
                },
                () => {
                    recordDiagnosticEvent({ category: "action", level: "warning", code: "generation_duplicate_click", canvasId: projectId, message: "该节点已有生成请求正在提交或执行" });
                    message.info({ key: `canvas-generation-submission-${nodeId}`, content: "该节点已有生成请求正在提交或执行，请勿重复点击" });
                },
            );
        },
        [
            addedSkills,
            applyGenerationTaskResult,
            bindGenerationTask,
            confirmDuplicateSubmission,
            domainProjectId,
            effectiveConfig,
            finishGenerationRequest,
            isAiConfigReady,
            isLiveRequestNode,
            message,
            modal,
            nodesRef,
            connectionsRef,
            projectId,
            setConnections,
            setDialogNodeId,
            setNodes,
            setRunningNodeId,
            setSelectedConnectionId,
            setSelectedNodeIds,
            startGenerationRequest,
        ],
    );
}


function generationModelRequirements(
    mode: CanvasNodeGenerationMode,
    input: Pick<Awaited<ReturnType<typeof hydrateNodeGenerationContext>>, "textCount" | "imageCount" | "videoCount" | "audioCount" | "characterReferences">,
    sourceNode: CanvasNodeData | undefined,
    config: ReturnType<typeof useEffectiveConfig>,
    includeCharacterMinimum = false,
): ModelRequirements {
    return resolvedCanvasGenerationRequirements(config, sourceNode, mode, {
            textCount: input.textCount,
            imageCount: input.imageCount,
            videoCount: input.videoCount,
            audioCount: input.audioCount,
            characterCount: includeCharacterMinimum ? input.characterReferences.length : 0,
    });
}
