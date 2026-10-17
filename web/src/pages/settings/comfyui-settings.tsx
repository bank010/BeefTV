import { Alert, App, Button, Form, Input, Radio, Select } from "antd";
import { useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Check, FileJson, Folder, Save, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";

import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { Switch } from "@/components/ui/base/switch";
import { workflowProviderPluginEnabled } from "@/lib/plugins/builtin/workflows";
import { cn } from "@/lib/utils";
import { comfyUIImageRoutingError } from "@/lib/comfyui-image-routing";
import { workflowMediaInputLimit } from "@/lib/model-capabilities";
import { fetchComfyUIUserData, fetchComfyUIWorkflow, type ComfyUIUserDataItem } from "@/services/api/comfyui";
import { commitModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { useConfigStore, type ComfyUIConfig, type ComfyUIWorkflow, type RunningHubCapability } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";

const capabilities = [
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

type WorkflowDraft = { title: string; capability?: RunningHubCapability; imageEditWorkflowId?: string; error?: string };

function fileName(path: string) {
    return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || path;
}

// ComfyUI may return a path relative to the listed directory or the full workflows/ path.
function comfyUIFilePath(directory: string, name: string) {
    const path = name.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    return path.startsWith("workflows/") || path === "workflows" ? path : `${directory.replace(/\/+$/, "")}/${path}`;
}

export default function ComfyUISettingsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const config = useConfigStore((state) => state.config.comfyUI);
    const runtimeStatuses = usePluginStore((state) => state.runtimeStatuses);
    const pluginEnabled = workflowProviderPluginEnabled(runtimeStatuses, "comfyui");
    const [connection, setConnection] = useState(() => ({ baseUrl: config.baseUrl, apiKey: config.apiKey, enabled: config.enabled }));
    const [directory, setDirectory] = useState("workflows");
    const [listedDirectory, setListedDirectory] = useState("");
    const [files, setFiles] = useState<ComfyUIUserDataItem[]>([]);
    const [listing, setListing] = useState(false);
    const [directoryError, setDirectoryError] = useState("");
    const [selectedId, setSelectedId] = useState(config.selectedWorkflowId);
    const [drafts, setDrafts] = useState<Record<string, WorkflowDraft>>({});
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const fileListRef = useRef<HTMLElement>(null);
    const editorRef = useRef<HTMLElement>(null);
    const busy = saving || deleting;
    const selected = config.workflows.find((workflow) => workflow.workflowId === selectedId);
    const draft = drafts[selectedId] || (selected ? { title: selected.title, capability: selected.capability, imageEditWorkflowId: selected.imageEditWorkflowId } : undefined);
    const connectionChanged = connection.baseUrl.trim().replace(/\/+$/, "") !== config.baseUrl || connection.apiKey !== config.apiKey || connection.enabled !== config.enabled;
    const changed = Boolean(draft && (!selected || draft.title.trim() !== selected.title || draft.capability !== selected.capability || (draft.imageEditWorkflowId || "") !== (selected.imageEditWorkflowId || "") || draft.error)) || connectionChanged;
    const imageModelOwner = config.workflows.find((item) => item.imageEditWorkflowId === selectedId);

    const updateDraft = (patch: Partial<WorkflowDraft>) => {
        if (draft) setDrafts((current) => ({ ...current, [selectedId]: { ...draft, ...patch, error: "" } }));
    };

    const selectFile = (id: string) => {
        setSelectedId(id);
        if (!drafts[id] && !config.workflows.some((workflow) => workflow.workflowId === id)) {
            setDrafts((current) => ({ ...current, [id]: { title: fileName(id).replace(/\.json$/i, "") } }));
        }
        if (window.matchMedia("(max-width: 1023px)").matches) {
            requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "start" }));
        }
    };

    const listWorkflows = async (path = directory) => {
        const target = path.trim().replace(/\/+$/, "") || "workflows";
        setDirectory(target);
        setListing(true);
        setDirectoryError("");
        try {
            const result = await fetchComfyUIUserData({ baseUrl: connection.baseUrl.trim(), apiKey: connection.apiKey, directory: target });
            setFiles(result.filter((item) => item && typeof item.name === "string"));
            setListedDirectory(target);
        } catch (error) {
            setDirectoryError(error instanceof Error ? error.message : "读取目录失败，请重试");
        } finally {
            setListing(false);
        }
    };

    const persist = async (next: ComfyUIConfig) => {
        // Publish to model pickers only after the backend has acknowledged this snapshot.
        await commitModelConfig({ ...useConfigStore.getState().config, comfyUI: next });
        const state = getModelConfigPersistenceState();
        if (state.status !== "saved" || state.dirty) throw new Error(state.error || "服务器尚未确认保存，请重试");
        useConfigStore.getState().updateConfig("comfyUI", next);
    };

    const saveWorkflow = async () => {
        if (!draft?.capability || !draft.title.trim() || !selectedId || busy) return;
        setSaving(true);
        updateDraft({ error: "" });
        try {
            const baseUrl = connection.baseUrl.trim().replace(/\/+$/, "");
            if (!baseUrl) throw new Error("请先填写 ComfyUI 地址");
            let workflow = selected;
            if (!workflow || workflow.capability !== draft.capability || baseUrl !== config.baseUrl || connection.apiKey !== config.apiKey) {
                if (!pluginEnabled) throw new Error("请先在插件中心启用 ComfyUI 工作流插件");
                workflow = await fetchComfyUIWorkflow({ baseUrl, apiKey: connection.apiKey, file: selectedId, capability: draft.capability });
            }
            const saved: ComfyUIWorkflow = { ...workflow, workflowId: selectedId, title: draft.title.trim(), capability: draft.capability, imageEditWorkflowId: draft.capability === "image" ? draft.imageEditWorkflowId || undefined : undefined };
            const latest = useConfigStore.getState().config.comfyUI;
            const workflows = latest.workflows.some((item) => item.workflowId === selectedId)
                ? latest.workflows.map((item) => item.workflowId === selectedId ? saved : item)
                : [...latest.workflows, saved];
            const routingError = comfyUIImageRoutingError(workflows);
            if (routingError) throw new Error(routingError);
            for (const owner of workflows.filter((item) => item.imageEditWorkflowId)) {
                const edit = workflows.find((item) => item.workflowId === owner.imageEditWorkflowId)!;
                if (!workflowMediaInputLimit(edit.fields, ["referenceimage", "image", "referenceimages"])) throw new Error("有图工作流未识别到参考图输入，请检查源文件并重新读取");
            }
            await persist({ ...latest, ...connection, baseUrl, selectedWorkflowId: selectedId, workflows });
            setConnection((current) => ({ ...current, baseUrl }));
            setDrafts((current) => ({ ...current, [selectedId]: { title: saved.title, capability: saved.capability, imageEditWorkflowId: saved.imageEditWorkflowId } }));
            message.success(`“${saved.title}”配置已保存到服务器`);
        } catch (error) {
            setDrafts((current) => ({ ...current, [selectedId]: { ...draft, error: error instanceof Error ? error.message : "保存失败，请重试" } }));
        } finally {
            setSaving(false);
        }
    };

    const removeWorkflow = async () => {
        if (!selected || busy) return;
        setDeleting(true);
        try {
            const latest = useConfigStore.getState().config.comfyUI;
            const owner = latest.workflows.find((item) => item.imageEditWorkflowId === selectedId);
            if (owner) throw new Error(`此工作流用于“${owner.title}”的有图生成，请先在该模型中解除关联`);
            await persist({ ...latest, selectedWorkflowId: latest.selectedWorkflowId === selectedId ? "" : latest.selectedWorkflowId, workflows: latest.workflows.filter((item) => item.workflowId !== selectedId) });
            setDrafts((current) => ({ ...current, [selectedId]: { title: selected.title, capability: selected.capability } }));
            message.success("已移除配置，ComfyUI 中的源文件仍然保留");
        } catch (error) {
            setDrafts((current) => ({ ...current, [selectedId]: { ...draft!, error: error instanceof Error ? error.message : "移除失败，请重试" } }));
        } finally {
            setDeleting(false);
        }
    };

    const entries = new Map<string, string>();
    for (const item of files) {
        if (item.type !== "directory" && item.type !== "dir" && /\.json$/i.test(item.name)) {
            entries.set(comfyUIFilePath(listedDirectory, item.name), fileName(item.name));
        }
    }
    for (const workflow of config.workflows) if (!entries.has(workflow.workflowId)) entries.set(workflow.workflowId, fileName(workflow.workflowId));
    for (const id of Object.keys(drafts)) if (!entries.has(id)) entries.set(id, fileName(id));
    const directories = files.filter((item) => item.type === "directory" || item.type === "dir");
    const fields = selected?.fields.filter((field) => field.enabled !== false && field.safeToOverride !== false) || [];

    return (
        <WorkspacePage>
            <PageHeader title="ComfyUI 工作流" description="选择 JSON 文件，设置用途，保存后即可在对应的模型列表中使用。" />
            <div className="mt-4 space-y-4">
                {!pluginEnabled ? <Alert type="warning" showIcon title="读取工作流需要启用 ComfyUI 插件" action={<Button onClick={() => navigate("/plugins")}>打开插件中心</Button>} /> : null}
                <section className="settings-section rounded-xl border border-border/60 bg-surface p-4">
                    <div className="settings-pane-header">
                        <div><h2>ComfyUI 连接</h2><p>连接信息随当前工作流一起保存，供所有已保存工作流共用。</p></div>
                        <label className="flex items-center gap-2 text-sm">
                            <span>在模型列表中启用</span>
                            <Switch aria-label="在模型列表中启用" checked={connection.enabled} disabled={busy} onChange={(enabled) => setConnection((current) => ({ ...current, enabled }))} />
                        </label>
                    </div>
                    <Form layout="vertical" requiredMark={false} className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Form.Item label="ComfyUI 地址" htmlFor="comfyui-url" className="mb-0">
                            <Input id="comfyui-url" value={connection.baseUrl} disabled={busy || listing} placeholder="https://your-comfyui-host" onChange={(event) => { setConnection((current) => ({ ...current, baseUrl: event.target.value })); setFiles([]); setListedDirectory(""); }} />
                        </Form.Item>
                        <Form.Item label="API Key（可选）" htmlFor="comfyui-key" className="mb-0">
                            <Input.Password id="comfyui-key" autoComplete="new-password" value={connection.apiKey} disabled={busy || listing} onChange={(event) => setConnection((current) => ({ ...current, apiKey: event.target.value }))} />
                        </Form.Item>
                    </Form>
                </section>

                <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                    <section ref={fileListRef} aria-label="工作流文件" className="min-w-0 rounded-xl border border-border/60 bg-surface p-4">
                        <h2 className="font-medium">工作流文件 <span className="text-sm text-foreground/55">{entries.size ? `· ${entries.size}` : ""}</span></h2>
                        <label htmlFor="comfyui-directory" className="mt-3 block text-xs text-foreground/60">工作流目录</label>
                        <div className="mt-1 flex gap-2">
                            <Input id="comfyui-directory" className="min-w-0" value={directory} disabled={busy || listing} onChange={(event) => setDirectory(event.target.value)} onPressEnter={() => { if (pluginEnabled && connection.baseUrl.trim() && !listing) void listWorkflows(); }} />
                            <Button loading={listing} disabled={busy || !pluginEnabled || !connection.baseUrl.trim()} onClick={() => void listWorkflows()}>读取目录</Button>
                        </div>
                        {directoryError ? <p role="alert" className="mt-3 text-sm text-destructive">{directoryError}</p> : null}
                        {listedDirectory ? <div className="mt-3 flex items-center gap-2 text-xs text-foreground/55">
                            {listedDirectory !== "workflows" ? <Button size="small" type="text" aria-label="上一级目录" icon={<ArrowUp className="size-3.5" />} disabled={busy || listing} onClick={() => void listWorkflows(listedDirectory.split("/").slice(0, -1).join("/"))} /> : null}
                            <span className="break-all">{listedDirectory}</span>
                        </div> : null}
                        <div className="mt-3 flex max-h-96 flex-col gap-1 overflow-y-auto">
                            {directories.map((item) => <Button key={item.name} type="text" className="justify-start" icon={<Folder className="size-4" />} disabled={busy || listing} onClick={() => void listWorkflows(comfyUIFilePath(listedDirectory, item.name))}>{fileName(item.name)}</Button>)}
                            {[...entries].map(([id, name]) => {
                                const saved = config.workflows.find((item) => item.workflowId === id);
                                const pending = drafts[id];
                                 const dirty = pending && (!saved || pending.title.trim() !== saved.title || pending.capability !== saved.capability || (pending.imageEditWorkflowId || "") !== (saved.imageEditWorkflowId || "") || pending.error);
                                return <button key={id} type="button" aria-pressed={selectedId === id} disabled={busy} onClick={() => selectFile(id)} className={cn("flex w-full items-start gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60", selectedId === id ? "border-border bg-muted" : "border-transparent hover:bg-muted/50")}>
                                    <FileJson aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground/55" />
                                    <span className="min-w-0 flex-1"><span className="block break-all text-sm font-medium">{name}</span><span className="mt-1 block break-all text-xs text-foreground/55">{id}</span></span>
                                    <span className="shrink-0 text-xs text-foreground/55">{dirty ? "未保存" : saved ? `${capabilities.find((item) => item.value === saved.capability)?.label} · 已保存` : "待配置"}</span>
                                </button>;
                            })}
                        </div>
                        {!entries.size && !directories.length ? <p className="py-6 text-sm leading-6 text-foreground/55">{listedDirectory ? "此目录下没有 JSON 工作流，可修改目录后重新读取。" : "填写连接地址并读取目录，然后选择要配置的 JSON 文件。"}</p> : null}
                        {Object.keys(drafts).length ? <p className="mt-3 text-xs text-foreground/55">切换文件会保留本页草稿；离开或刷新前请保存。</p> : null}
                    </section>

                    <section ref={editorRef} aria-label="当前工作流配置" className="min-w-0 scroll-mt-4 rounded-xl border border-border/60 bg-surface p-4">
                        {!draft ? <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-4 text-center">
                            <FileJson className="size-8 text-foreground/35" />
                            <h2 className="font-medium">选择一个工作流</h2>
                            <p className="text-sm text-foreground/55">从文件列表选择 JSON，在这里设置名称和用途。</p>
                        </div> : <>
                            <div className="mb-3 lg:hidden"><Button type="text" size="small" icon={<ArrowLeft className="size-3.5" />} onClick={() => fileListRef.current?.scrollIntoView({ block: "start" })}>选择其他文件</Button></div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0"><h2 className="break-all font-medium">{fileName(selectedId)}</h2><p className="mt-1 break-all text-xs text-foreground/55">{selectedId}</p></div>
                                <span role="status" className="flex shrink-0 items-center gap-1 text-xs text-foreground/60">{busy ? (saving ? "正在保存…" : "正在移除…") : draft.error ? "操作失败" : changed ? "未保存" : <><Check className="size-3.5" />已保存到服务器</>}</span>
                            </div>
                            <Form layout="vertical" requiredMark={false} className="mt-5">
                                <Form.Item label="显示名称" htmlFor="comfyui-title" extra="在模型列表中显示的名称。">
                                    <Input id="comfyui-title" value={draft.title} disabled={busy} onChange={(event) => updateDraft({ title: event.target.value })} />
                                </Form.Item>
                                <Form.Item label="工作流用途" extra={imageModelOwner ? "此文件作为已关联图片模型的有图工作流使用。" : draft.capability ? `保存后归入${capabilities.find((item) => item.value === draft.capability)?.label}模型列表。` : "选择这个工作流生成的内容类型。"}>
                                    <Radio.Group aria-label="工作流用途" options={capabilities} value={draft.capability} disabled={busy} onChange={(event) => updateDraft({ capability: event.target.value as RunningHubCapability })} />
                                </Form.Item>
                                {draft.capability === "image" ? imageModelOwner ? <p className="mb-4 text-sm text-foreground/60">已归入“{imageModelOwner.title}”。该模型有参考图时会自动使用此工作流。</p> : <Form.Item label="有参考图时使用" htmlFor="comfyui-image-edit" extra="关联后，模型列表只显示当前名称：无图使用当前文件，有图自动使用关联文件。先将另一个文件保存为图片工作流，再在这里选择。">
                                    <Select id="comfyui-image-edit" aria-label="有参考图时使用" allowClear placeholder="使用当前工作流" value={draft.imageEditWorkflowId || undefined} disabled={busy} onChange={(value) => updateDraft({ imageEditWorkflowId: value || undefined })} options={config.workflows.filter((item) => item.capability === "image" && item.workflowId !== selectedId && !item.imageEditWorkflowId && !config.workflows.some((owner) => owner.workflowId !== selectedId && owner.imageEditWorkflowId === item.workflowId)).map((item) => ({ value: item.workflowId, label: item.title }))} />
                                </Form.Item> : null}
                            </Form>
                            {!selected || selected.capability !== draft.capability ? <p className="mb-4 text-xs leading-5 text-foreground/55">保存时会读取该 JSON，并按所选用途解析生成参数。</p> : null}
                            {selected && selected.capability === draft.capability && fields.length ? <details className="mb-4 text-xs text-foreground/60">
                                <summary className="cursor-pointer">已识别 {fields.length} 个生成参数</summary>
                                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">{fields.map((field) => <li key={`${field.nodeId}:${field.fieldName}`} className="break-all">{field.label || field.fieldName}</li>)}</ul>
                            </details> : null}
                            {draft.error ? <Alert className="mb-4" type="error" showIcon title={draft.error} description="操作未完成，当前编辑内容已保留，可重试。" /> : null}
                            {!connection.enabled ? <p className="mb-4 text-xs text-foreground/55">ComfyUI 当前未启用。可先保存配置，启用后再从模型列表使用。</p> : null}
                            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
                                <Button type="primary" icon={<Save className="size-4" />} loading={saving} disabled={deleting || !draft.title.trim() || !draft.capability || !connection.baseUrl.trim() || !changed} onClick={() => void saveWorkflow()}>保存配置</Button>
                                {selected ? <Button type="text" danger icon={<Trash2 className="size-4" />} loading={deleting} disabled={saving} onClick={() => void removeWorkflow()}>移除配置</Button> : null}
                                <span className="text-xs text-foreground/55">仅保存当前工作流</span>
                            </div>
                        </>}
                    </section>
                </div>
            </div>
        </WorkspacePage>
    );
}
