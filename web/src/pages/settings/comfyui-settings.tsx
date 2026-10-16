import { Alert, App, Button, Form, Input } from "antd";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";

import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkflowGraphEditor } from "@/components/workflow-graph-editor";
import { workflowProviderPluginEnabled } from "@/lib/plugins/builtin/workflows";
import { fetchComfyUIUserData, fetchComfyUIWorkflow, type ComfyUIUserDataItem } from "@/services/api/comfyui";
import { useConfigStore, type ComfyUIConfig, type ComfyUIWorkflow, type RunningHubCapability } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import { Switch } from "@/components/ui/base/switch";
import { Select } from "@/components/ui/base/select";

const capabilities: { label: string; value: RunningHubCapability }[] = [
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

function fileName(item: ComfyUIUserDataItem) {
    return String(item.name || "").replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "";
}

export default function ComfyUISettingsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const config = useConfigStore((state) => state.config.comfyUI);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const runtimeStatuses = usePluginStore((state) => state.runtimeStatuses);
    const pluginEnabled = workflowProviderPluginEnabled(runtimeStatuses, "comfyui");
    const [directory, setDirectory] = useState("workflows/video");
    const [files, setFiles] = useState<ComfyUIUserDataItem[]>([]);
    const [listing, setListing] = useState(false);
    const [hasListed, setHasListed] = useState(false);
    const [loadingFile, setLoadingFile] = useState(false);
    const [directoryError, setDirectoryError] = useState("");
    const [workflowError, setWorkflowError] = useState("");
    const [workflowText, setWorkflowText] = useState("");
    const [titleDraft, setTitleDraft] = useState("");
    const selected = config.workflows.find((item) => item.workflowId === config.selectedWorkflowId);
    const selectedKey = selected?.workflowId;
    const workflowOptions = useMemo(() => config.workflows.map((item) => ({ value: item.workflowId, label: `${item.title || item.workflowId} · ${item.capability}` })), [config.workflows]);

    useEffect(() => {
        setWorkflowText(selected ? JSON.stringify(selected.workflowJson, null, 2) : "");
        setTitleDraft(selected?.title || "");
    }, [selectedKey, selected?.workflowJson, selected?.title]);

    const update = (patch: Partial<ComfyUIConfig>) => updateConfig("comfyUI", { ...config, ...patch });

    const saveWorkflow = (workflow: ComfyUIWorkflow) => {
        const normalized = { ...workflow, workflowId: workflow.workflowId.trim(), title: workflow.title.trim() || workflow.workflowId };
        update({
            selectedWorkflowId: normalized.workflowId,
            workflows: [...config.workflows.filter((item) => item.workflowId !== normalized.workflowId), normalized],
        });
    };

    const listWorkflows = async () => {
        if (!pluginEnabled) return message.warning("请先在插件中心启用 ComfyUI 工作流插件");
        const baseUrl = config.baseUrl.trim();
        if (!baseUrl) return message.warning("请先填写 ComfyUI Base URL");
        setListing(true);
        setFiles([]);
        setHasListed(false);
        setDirectoryError("");
        try {
            const result = await fetchComfyUIUserData({ baseUrl, apiKey: config.apiKey, directory: directory.trim() || "workflows" });
            const items = result.filter((item) => item && typeof item.name === "string");
            setFiles(items);
            setHasListed(true);
            if (items.length) message.success(`已读取 ${items.length} 个目录项`);
            else message.info("目录读取成功，但没有找到可展示的工作流文件");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "读取 ComfyUI 工作流目录失败";
            setDirectoryError(detail);
            message.error(`读取失败：${detail}`);
        } finally {
            setListing(false);
        }
    };

    const loadWorkflow = async (item: ComfyUIUserDataItem) => {
        const name = fileName(item);
        if (!name.toLowerCase().endsWith(".json")) return message.info("请选择 JSON 工作流文件");
        const file = `${directory.trim().replace(/\/+$/, "")}/${name}`;
        setLoadingFile(true);
        setWorkflowError("");
        try {
            const result = await fetchComfyUIWorkflow({ baseUrl: config.baseUrl.trim(), apiKey: config.apiKey, file, capability: "image" });
            saveWorkflow(result);
            setWorkflowText(JSON.stringify(result.workflowJson, null, 2));
            setTitleDraft(result.title);
            message.success(`已加载并保存：${result.title}`);
        } catch (error) {
            const detail = error instanceof Error ? error.message : "加载 ComfyUI 工作流失败";
            setWorkflowError(detail);
            message.error(`加载失败：${detail}`);
        } finally {
            setLoadingFile(false);
        }
    };

    const selectWorkflow = (workflowId?: string) => update({ selectedWorkflowId: workflowId || "" });
    const updateSelected = (patch: Partial<ComfyUIWorkflow>) => {
        if (selected) saveWorkflow({ ...selected, ...patch });
    };

    const updateWorkflowJson = () => {
        if (!selected) return;
        try {
            const parsed: unknown = JSON.parse(workflowText);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工作流 JSON 必须是对象");
            const graph = parsed as Record<string, unknown>;
            if (!Object.values(graph).every((node) => node && typeof node === "object" && "class_type" in node && "inputs" in node)) {
                throw new Error("执行工作流必须是 ComfyUI API 格式 JSON");
            }
            updateSelected({ workflowJson: graph, title: titleDraft.trim() || selected.title });
            message.success("工作流 JSON 已保存到本机配置");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "工作流 JSON 格式无效");
        }
    };

    const removeSelected = () => {
        if (!selected) return;
        update({ selectedWorkflowId: "", workflows: config.workflows.filter((item) => item.workflowId !== selected.workflowId) });
        message.success(`已删除：${selected.title || selected.workflowId}`);
    };

    const updateFields = (fields: ComfyUIWorkflow["fields"]) => updateSelected({ fields });

    return (
        <WorkspacePage>
            <PageHeader title="ComfyUI 工作流" description="通过本地后端读取工作流；配置与凭据独立于模型渠道和 RunningHub。" />
            <Form layout="vertical" requiredMark={false} className="mt-4">
                <section className="settings-section grid gap-3 rounded-xl border border-border/60 bg-surface p-4 lg:grid-cols-12">
                    {!pluginEnabled ? (
                        <Alert
                            className="lg:col-span-12"
                            type="warning"
                            showIcon
                            title="请先启用 ComfyUI 工作流插件"
                            description="目录读取和工作流生成需要插件处于启用状态。此页面的“启用”开关只控制 ComfyUI 连接配置。"
                            action={<Button type="link" onClick={() => navigate("/plugins")}>打开插件中心</Button>}
                        />
                    ) : null}
                    <div className="settings-pane-header lg:col-span-12">
                        <div className="min-w-0">
                            <h2>连接设置</h2>
                            <p>API Key 仅随请求发送到 BeefTV 后端，不会放入 ComfyUI URL。</p>
                        </div>
                        <Switch checked={config.enabled} checkedChildren="启用" unCheckedChildren="停用" onChange={(enabled) => update({ enabled })} />
                    </div>
                    <Form.Item label="Base URL" className="mb-0 lg:col-span-6">
                        <Input value={config.baseUrl} placeholder="https://your-comfyui-host" onChange={(event) => update({ baseUrl: event.target.value })} onBlur={() => update({ baseUrl: config.baseUrl.trim().replace(/\/+$/, "") })} />
                    </Form.Item>
                    <Form.Item label="API Key（可选）" className="mb-0 lg:col-span-6">
                        <Input.Password autoComplete="new-password" value={config.apiKey} onChange={(event) => update({ apiKey: event.target.value })} />
                    </Form.Item>
                    <Form.Item label="工作流目录" className="mb-0 lg:col-span-8">
                        <Input value={directory} placeholder="workflows/video" onChange={(event) => setDirectory(event.target.value)} onPressEnter={() => void listWorkflows()} />
                    </Form.Item>
                    <Form.Item label="操作" className="mb-0 lg:col-span-4">
                        <Button className="mt-7 w-full" icon={<RefreshCw className="size-4" />} loading={listing} onClick={() => void listWorkflows()}>
                            读取目录
                        </Button>
                    </Form.Item>
                    {directoryError ? <p className="lg:col-span-12 text-sm text-destructive" role="alert">读取目录失败：{directoryError}</p> : null}
                    {files.length ? (
                        <div className="lg:col-span-12">
                            <div className="mb-2 text-xs text-foreground/55">远程目录项 · 点击 JSON 文件加载到本机工作流库</div>
                            <div className="flex flex-wrap gap-2">
                                {files.map((item, index) => {
                                    const name = fileName(item);
                                    const isDirectory = item.type === "directory" || item.type === "dir";
                                    return <Button key={`${item.name}-${index}`} size="small" disabled={loadingFile} onClick={() => isDirectory ? setDirectory(`${directory.replace(/\/+$/, "")}/${name}`) : void loadWorkflow(item)}>{name || item.name}</Button>;
                                })}
                            </div>
                        </div>
                    ) : null}
                    {hasListed && files.length === 0 ? <p className="lg:col-span-12 text-sm text-foreground/60">目录读取成功，但没有可展示的工作流文件。请检查目录路径，例如 `workflows/video`。</p> : null}
                    {workflowError ? <p className="lg:col-span-12 text-sm text-destructive" role="alert">工作流加载失败：{workflowError}</p> : null}
                    <Form.Item label="已保存工作流" className="mb-0 lg:col-span-12">
                        <Select className="w-full" allowClear value={selected?.workflowId} options={workflowOptions} placeholder="选择已保存的工作流" onChange={(value) => selectWorkflow(value as string | undefined)} />
                    </Form.Item>
                    {selected ? (
                        <>
                            <Form.Item label="工作流用途" className="mb-0 lg:col-span-4">
                                <Select className="w-full" value={selected.capability} options={capabilities} onChange={(value) => updateSelected({ capability: value as RunningHubCapability })} />
                            </Form.Item>
                            <Form.Item label="显示名称" className="mb-0 lg:col-span-8">
                                <Input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => updateSelected({ title: titleDraft.trim() || selected.workflowId })} />
                            </Form.Item>
                            <div className="flex flex-wrap gap-2 lg:col-span-12">
                                <Button icon={<Save className="size-4" />} onClick={updateWorkflowJson}>保存 JSON</Button>
                                <Button danger icon={<Trash2 className="size-4" />} onClick={removeSelected}>删除本地配置</Button>
                            </div>
                            <details className="workflow-json-details lg:col-span-12">
                                <summary>查看或编辑 ComfyUI API JSON</summary>
                                <Form.Item className="mb-0 mt-3">
                                    <Input.TextArea rows={12} value={workflowText} spellCheck={false} onChange={(event) => setWorkflowText(event.target.value)} onBlur={updateWorkflowJson} />
                                </Form.Item>
                            </details>
                            <div className="lg:col-span-12">
                                <WorkflowGraphEditor workflowJson={selected.workflowJson} fields={selected.fields || []} onChange={updateFields} emptyDescription="当前工作流没有可映射字段" />
                            </div>
                        </>
                    ) : null}
                </section>
            </Form>
        </WorkspacePage>
    );
}
