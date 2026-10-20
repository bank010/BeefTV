import { useEffect, type ReactNode } from "react";
import type { VideoSettingsConstraints } from "@/lib/video-settings-constraints";
import { Switch } from "@/components/ui/base/switch";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceRatioOptions } from "@/lib/seedance-video";
import { isVolcengineArkVideoProtocol } from "@/lib/model-protocols";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { formatVideoResolutionLabel, isVideoResolutionMatch, normalizeVideoDuration, sortVideoResolutionOptions, videoDimensionsForRatioAndResolution, VIDEO_DURATION_MIN } from "@/lib/video-generation-options";
import { isSeedance25Model, modelCapabilityConfigFor, normalizeVideoValue, resolveVideoRatioValue, resolveVideoResolutionValue, videoDurationOptions, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

const sizeOptions = [
    { value: "1280x720", label: "横屏", width: 1280, height: 720 },
    { value: "720x1280", label: "竖屏", width: 720, height: 1280 },
    { value: "1024x1024", label: "方形", width: 1024, height: 1024 },
    { value: "1792x1024", label: "宽屏", width: 1792, height: 1024 },
    { value: "1024x1792", label: "长图", width: 1024, height: 1792 },
    { value: "auto", label: "auto", width: 0, height: 0 },
];

const MAX_VIDEO_RESOLUTION_1080P_MP = (1920 * 1080) / 1_000_000;
const WORKFLOW_RESOLUTION_TIERS = [
    { label: "480p", megapixels: (854 * 480) / 1_000_000 },
    { label: "720p", megapixels: (1280 * 720) / 1_000_000 },
    { label: "1080p", megapixels: MAX_VIDEO_RESOLUTION_1080P_MP },
] as const;

type WorkflowResolutionTier = { label: (typeof WORKFLOW_RESOLUTION_TIERS)[number]["label"]; value: number };

function workflowVideoResolutionSliderMax(range: NonNullable<VideoCapabilityConfig["resolutionRange"]>) {
    const capped = Math.min(range.max, MAX_VIDEO_RESOLUTION_1080P_MP);
    const steps = Math.floor((capped - range.min) / range.step + 1e-7);
    return Math.max(range.min, Number((range.min + Math.max(0, steps) * range.step).toPrecision(8)));
}

function workflowVideoResolutionTiers(range: NonNullable<VideoCapabilityConfig["resolutionRange"]>): WorkflowResolutionTier[] {
    const max = workflowVideoResolutionSliderMax(range);
    const rawMax = Math.min(range.max, MAX_VIDEO_RESOLUTION_1080P_MP);
    const tiers = WORKFLOW_RESOLUTION_TIERS.flatMap(({ label, megapixels }) => {
        if (megapixels < range.min - range.step / 2 || megapixels > rawMax + range.step / 2) return [];
        const value = clampWorkflowVideoResolution(megapixels, range, max);
        return [{ label, value }];
    });
    const distinct = tiers.filter((tier, index) => tiers.findIndex((candidate) => candidate.value === tier.value) === index);
    return distinct.length ? distinct : [{ label: "480p", value: range.min }];
}

function nearestWorkflowResolutionTier(value: string | number, tiers: WorkflowResolutionTier[]) {
    const parsed = Number(value);
    const candidate = Number.isFinite(parsed) ? parsed : tiers[0]!.value;
    return tiers.reduce((best, tier) => Math.abs(tier.value - candidate) < Math.abs(best.value - candidate) ? tier : best, tiers[0]!);
}

function clampWorkflowVideoResolution(value: string | number, range: NonNullable<VideoCapabilityConfig["resolutionRange"]>, max: number) {
    const parsed = Number(value);
    const candidate = Number.isFinite(parsed) ? parsed : range.min;
    const clamped = Math.min(max, Math.max(range.min, candidate));
    const steps = Math.round((clamped - range.min) / range.step);
    return Number((range.min + steps * range.step).toPrecision(8));
}

function videoDurationAtResolution(profile: VideoCapabilityConfig, maxSeconds: number): VideoCapabilityConfig {
    if (!Number.isFinite(maxSeconds)) return profile;
    if (profile.duration.selection === "range") {
        const min = profile.duration.fractionalMin ?? profile.duration.min ?? 1;
        return { ...profile, duration: { ...profile.duration, max: Math.max(min, Math.min(profile.duration.max ?? maxSeconds, maxSeconds)) } };
    }
    const values = (profile.duration.values || []).filter((value) => value <= maxSeconds);
    const defaultValue = values.reduce<number | undefined>((best, value) => best === undefined || Math.abs(value - Math.min(profile.duration.default, maxSeconds)) < Math.abs(best - Math.min(profile.duration.default, maxSeconds)) ? value : best, undefined);
    return values.length
        ? { ...profile, duration: { ...profile.duration, values, default: defaultValue ?? values[0]! } }
        : profile;
}

function workflowDurationOptions(profile: VideoCapabilityConfig) {
    if (profile.duration.selection === "range") {
        const min = profile.duration.fractionalMin ?? profile.duration.min ?? VIDEO_DURATION_MIN;
        const max = Math.max(min, profile.duration.max ?? min);
        const step = profile.duration.continuous ? 0.1 : Math.max(1, profile.duration.step || 1);
        const values: number[] = [];
        for (let value = min; value <= max + 1e-7 && values.length < 1000; value = Number((value + step).toPrecision(8))) values.push(value);
        return values;
    }
    return [...new Set((profile.duration.values || []).filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
}

type VideoSettingsPanelProps = {
    taskConstraints?: VideoSettingsConstraints;
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoArkPrivateAssetUpload", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[292px] space-y-3", taskConstraints }: VideoSettingsPanelProps) {
    const profile = modelCapabilityConfigFor(config, config.model).video!;
    const range = profile.resolutionRange;
    const maxResolution = range ? workflowVideoResolutionSliderMax(range) : 0;
    const resolutionTiers = range ? workflowVideoResolutionTiers(range) : [];
    const selectedResolutionTier = range ? nearestWorkflowResolutionTier(resolveVideoResolutionValue(profile, config.vquality), resolutionTiers) : undefined;
    const fullHdLimit = selectedResolutionTier?.label === "1080p";
    const durationProfile = fullHdLimit ? videoDurationAtResolution(profile, 10) : profile;
    const durationOptions = workflowDurationOptions(durationProfile);
    const maxAvailableDuration = durationProfile.duration.selection === "range"
        ? durationProfile.duration.max ?? 10
        : durationOptions.length ? durationOptions[durationOptions.length - 1]! : 10;
    useEffect(() => {
        if (!range) return;
        const configured = Number(config.vquality);
        if (!Number.isFinite(configured) || configured !== selectedResolutionTier?.value) onConfigChange("vquality", String(selectedResolutionTier?.value ?? maxResolution));
        if (fullHdLimit && Number(config.videoSeconds) > maxAvailableDuration) onConfigChange("videoSeconds", String(maxAvailableDuration));
    }, [config.vquality, config.videoSeconds, fullHdLimit, maxAvailableDuration, maxResolution, onConfigChange, range, selectedResolutionTier?.value]);
    if (resolveModelRequestConfig(config, config.model).interfaceType === "volcengine-jimeng-video") {
        return <JiMengVideoSettingsPanel config={config} profile={profile} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} />;
    }
    if (isSeedanceVideoConfig(config)) {
        return <SeedanceVideoSettingsPanel config={config} profile={profile} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} taskConstraints={taskConstraints} />;
    }

    const seconds = normalizeVideoValue(durationProfile, { seconds: config.videoSeconds }).seconds;
    const resolution = resolveVideoResolutionValue(profile, config.vquality);
    const ratio = resolveVideoRatioValue(profile, config.size);
    const dimensions = profile.resolutionRange ? undefined : videoDimensionsForRatioAndResolution(ratio, resolution);
    const sizeSupported = profile.ratios.length > 0;
    const configuredResolutions = sortVideoResolutionOptions(profile.resolutions).map((value) => ({ value, label: formatVideoResolutionLabel(value) }));
    const generateAudio = boolConfig(config.videoGenerateAudio, profile.generateAudio.default);
    const watermark = boolConfig(config.videoWatermark, profile.watermark.default);
    const workflowDuration = config.model.startsWith("comfyui-workflow::") && profile.duration.selection === "enum" && !profile.duration.values?.length;

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-sm font-semibold">视频设置</div> : null}
                {range ? (
                    <SettingGroup title="分辨率" color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-1.5">
                            {resolutionTiers.map((tier) => (
                                <OptionPill
                                    key={tier.label}
                                    selected={selectedResolutionTier?.label === tier.label}
                                    theme={theme}
                                    onClick={() => {
                                        onConfigChange("vquality", String(tier.value));
                                        if (tier.label === "1080p" && Number(config.videoSeconds) > 10) onConfigChange("videoSeconds", "10");
                                    }}
                                >
                                    {tier.label}
                                </OptionPill>
                            ))}
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                            {`${selectedResolutionTier?.label || "480p"} 时，视频最长支持 ${maxAvailableDuration} 秒。`}
                        </p>
                    </SettingGroup>
                ) : configuredResolutions.length ? (
                    <SettingGroup title="分辨率" color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-1.5">
                            {configuredResolutions.map((item) => (
                                <OptionPill key={item.value} selected={isVideoResolutionMatch(resolution, item.value)} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                ) : null}
                {sizeSupported ? (
                    <SettingGroup title={taskConstraints?.ratioLabel ? "比例" : "尺寸"} color={theme.node.muted}>
                        {taskConstraints?.ratioLabel ? (
                            <div className="rounded-md px-2.5 py-2" style={{ background: theme.toolbar.itemHover }}>
                                <p className="text-[length:var(--fs-body)] font-medium">{taskConstraints.ratioLabel}</p>
                                {taskConstraints.ratioHelp ? <p className="mt-1 text-[length:var(--fs-caption)] leading-relaxed" style={{ color: theme.node.muted }}>{taskConstraints.ratioHelp}</p> : null}
                            </div>
                        ) : <>
                        {taskConstraints?.ratioHelp ? <p className="text-[length:var(--fs-caption)] leading-relaxed" style={{ color: theme.node.muted }}>{taskConstraints.ratioHelp}</p> : null}
                        {dimensions ? (
                            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                                <DimensionValue prefix="W" value={dimensions.width} theme={theme} />
                                <span className="text-xs opacity-45">×</span>
                                <DimensionValue prefix="H" value={dimensions.height} theme={theme} />
                            </div>
                        ) : null}
                        <div className="grid grid-cols-3 gap-1.5">
                            {profile.ratios.map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1 text-[var(--fs-label)] font-medium transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                                    style={{ background: ratio === value ? theme.toolbar.activeBg : "transparent", color: theme.node.text, outlineColor: theme.node.muted }}
                                    aria-pressed={ratio === value}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange("size", value)}
                                >
                                    <SizePreview width={ratioPreview(value).width} height={ratioPreview(value).height} color={theme.node.text} />
                                    <span>{videoSizeLabel(value)}</span>
                                </button>
                            ))}
                        </div>
                        </>}
                    </SettingGroup>
                ) : null}
                <SettingGroup title="秒数" color={theme.node.muted}>
                    {workflowDuration ? <p className="text-sm">由工作流决定</p> : range
                        && durationOptions.length
                        ? <WorkflowDurationSlider options={durationOptions} value={Number(seconds)} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} />
                        : <VideoDurationControl profile={durationProfile} value={Number(seconds)} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} />}
                </SettingGroup>
                {profile.generateAudio.supported || profile.watermark.supported ? (
                    <SettingGroup title="输出" color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-3 rounded-md px-2" style={{ background: theme.toolbar.itemHover }}>
                            {profile.generateAudio.supported ? <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                            {profile.watermark.supported ? <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} /> : null}
                        </div>
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function JiMengVideoSettingsPanel({ config, profile, onConfigChange, theme, showTitle, className }: VideoSettingsPanelProps & { profile: VideoCapabilityConfig }) {
    const seconds = normalizeVideoDuration(config.videoSeconds);
    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-sm font-semibold">视频设置</div> : null}
                <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-1.5">
                        {profile.ratios.map((value) => (
                            <OptionPill key={value} selected={config.size === value} theme={theme} onClick={() => onConfigChange("size", value)}>
                                {value}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title="秒数" color={theme.node.muted}>
                    <VideoDurationControl profile={profile} value={Number(seconds)} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} />
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function SeedanceVideoSettingsPanel({ config, profile, onConfigChange, theme, showTitle, className, taskConstraints }: VideoSettingsPanelProps & { profile: VideoCapabilityConfig }) {
    const model = modelOptionName(config.model || config.videoModel);
    const resolution = normalizeSeedanceResolution(config.vquality, model);
    const ratio = taskConstraints?.ratioLabel ? "adaptive" : normalizeSeedanceRatio(config.size);
    const duration = normalizeSeedanceDuration(config.videoSeconds);
    const generateAudio = boolConfig(config.videoGenerateAudio, profile.generateAudio.default);
    const watermark = boolConfig(config.videoWatermark, profile.watermark.default);
    const useArkPrivateAssets = boolConfig(config.videoArkPrivateAssetUpload, true);
    const isArkSeedance = isVolcengineArkVideoProtocol(resolveModelRequestConfig(config, config.model).interfaceType);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-sm font-semibold">视频设置</div> : null}
                {isSeedance25Model(model) ? (
                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                        首尾帧和延长模式的比例跟随素材；编辑模式还会跟随原视频时长。需要自由设置时，请选择参考生成。
                    </p>
                ) : null}
                <SettingGroup title="分辨率" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-1.5">
                        {sortVideoResolutionOptions(profile.resolutions).map((value) => {
                            const item = { value, label: value.toUpperCase() };
                            return (
                                <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                    {item.label}
                                </OptionPill>
                            );
                        })}
                    </div>
                </SettingGroup>
                <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-1.5">
                        {(taskConstraints?.ratioLabel ? ["adaptive"] : profile.ratios).map((value) => {
                            const item = { value, label: taskConstraints?.ratioLabel || value };
                            return (
                                <button
                                    key={item.value}
                                    type="button"
                                    disabled={Boolean(taskConstraints?.ratioLabel)}
                                    className="flex h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md px-1 text-[var(--fs-tiny)] font-medium leading-none transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                                    style={{ background: ratio === item.value ? theme.toolbar.activeBg : "transparent", color: theme.node.text, outlineColor: theme.node.muted }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange("size", item.value)}
                                >
                                    <span className="grid h-4 place-items-center">
                                        <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={theme.node.text} />
                                    </span>
                                    <span className="whitespace-nowrap">{item.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </SettingGroup>
                <SettingGroup title="时长" color={theme.node.muted}>
                    {taskConstraints?.durationLocked ? <p className="text-sm">随原视频</p> : <VideoDurationControl profile={profile} value={duration} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} />}
                </SettingGroup>
                <SettingGroup title="输出" color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-3 rounded-md px-2" style={{ background: theme.toolbar.itemHover }}>
                        {profile.generateAudio.supported ? <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                        {profile.watermark.supported ? <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} /> : null}
                    </div>
                </SettingGroup>
                {isArkSeedance ? (
                    <SettingGroup title="参考图" color={theme.node.muted}>
                        <div className="rounded-md px-2" style={{ background: theme.toolbar.itemHover }}>
                            <SwitchRow label="自动同步可信素材（确认拥有使用权）" checked={useArkPrivateAssets} theme={theme} onChange={(checked) => onConfigChange("videoArkPrivateAssetUpload", String(checked))} />
                        </div>
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
        const megapixels = Number(value);
        return WORKFLOW_RESOLUTION_TIERS.reduce((best, tier) => Math.abs(tier.megapixels - megapixels) < Math.abs(best.megapixels - megapixels) ? tier : best, WORKFLOW_RESOLUTION_TIERS[0]!).label;
    }
    return formatVideoResolutionLabel(value);
}

export function videoSizeLabel(value: string) {
    if (value === "adaptive" || value === "auto") return "自适应";
    // Workflow enum values can include descriptions; keep the submitted value
    // intact while displaying its actual ratio instead of a landscape fallback.
    const ratio = value.trim().match(/^(\d+)\s*:\s*(\d+)(?=\s|\(|$)/);
    if (ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0) return `${ratio[1]}:${ratio[2]}`;
    return sizeOptions.find((item) => item.value === value)?.label || value;
}

export function videoSecondsLabel(value: string, profile?: VideoCapabilityConfig) {
    const normalized = profile ? normalizeVideoValue(profile, { seconds: value }).seconds : normalizeVideoDuration(value);
    return normalized === "-1" ? "自动" : `${normalized}s`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            className="h-8 cursor-pointer whitespace-nowrap rounded-md px-1 text-[var(--fs-label)] font-medium leading-none transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: selected ? theme.toolbar.activeBg : "transparent", color: theme.node.text, outlineColor: theme.node.muted }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-1.5">
            <div className="text-[var(--fs-tiny)] font-semibold" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function DimensionValue({ prefix, value, theme }: { prefix: string; value: number; theme: CanvasTheme }) {
    return (
        <div className="flex h-8 overflow-hidden rounded-md text-[var(--fs-label)]" style={{ background: theme.toolbar.itemHover, color: theme.node.text }}>
            <span className="grid w-7 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <span className="min-w-0 flex-1 px-2 leading-8 tabular-nums">{value}</span>
        </div>
    );
}

function DurationInput({ value, min, max, theme, onChange, continuous = false }: { value: number; min: number; max?: number; theme: CanvasTheme; onChange: (value: number) => void; continuous?: boolean }) {
    const commit = (input: HTMLInputElement) => {
        const parsed = Number(input.value);
        const candidate = continuous ? (input.value.trim() && Number.isFinite(parsed) ? parsed : value || min) : parsed || value || min;
        const next = Math.min(max || Number.POSITIVE_INFINITY, Math.max(min, continuous ? candidate : Math.floor(candidate)));
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-8 w-20 shrink-0 items-center overflow-hidden rounded-md border text-[var(--fs-label)]" style={{ background: theme.toolbar.itemHover, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <input
                key={`${min}-${value}`}
                type="number"
                inputMode={continuous ? "decimal" : "numeric"}
                step={continuous ? "any" : 1}
                min={min}
                max={max}
                defaultValue={value}
                aria-label="视频时长（秒）"
                className="min-w-0 flex-1 bg-transparent pl-2 text-right outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <span className="shrink-0 px-1.5" style={{ color: theme.node.muted }}>
                秒
            </span>
        </label>
    );
}

function VideoDurationControl({ profile, value, theme, disabled, onChange }: { profile: VideoCapabilityConfig; value: number; theme: CanvasTheme; disabled?: (value: number) => boolean; onChange: (value: number) => void }) {
    if (profile.duration.selection === "range") {
        const min = profile.duration.fractionalMin ?? (profile.duration.min || VIDEO_DURATION_MIN);
        const max = Math.max(min, profile.duration.max || min);
        const step = Math.max(1, profile.duration.step || 1);
        const normalized = profile.duration.continuous
            ? Math.max(min, Math.min(max, Number.isFinite(value) ? value : profile.duration.default))
            : normalizeDurationValue(value, profile.duration.default, min, max, step);
        return (
            <DurationRangeControl
                value={normalized}
                min={min}
                max={max}
                step={profile.duration.continuous ? "any" : step}
                continuous={profile.duration.continuous}
                theme={theme}
                onChange={(next) => {
                    if (!disabled?.(next)) onChange(next);
                }}
            />
        );
    }

    const options = videoDurationOptions(profile);
    return (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 4)}, minmax(0, 1fr))` }}>
            {options.map((option) => (
                <OptionPill key={option} selected={normalizedNumber(value) === option} disabled={disabled?.(option)} theme={theme} onClick={() => onChange(option)}>
                    {option === -1 ? "自动" : `${option}s`}
                </OptionPill>
            ))}
        </div>
    );
}

function WorkflowDurationSlider({ options, value, theme, onChange }: { options: number[]; value: number; theme: CanvasTheme; onChange: (value: number) => void }) {
    const selectedIndex = options.reduce((bestIndex, option, index) => Math.abs(option - value) < Math.abs(options[bestIndex]! - value) ? index : bestIndex, 0);
    const selectedValue = options[selectedIndex] ?? options[0] ?? 1;
    const formatSeconds = (seconds: number) => `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
                <span style={{ color: theme.node.muted }}>时长</span>
                <span className="font-semibold tabular-nums" style={{ color: theme.node.text }}>{formatSeconds(selectedValue)}</span>
            </div>
            <input
                type="range"
                min={0}
                max={Math.max(0, options.length - 1)}
                step={1}
                value={selectedIndex}
                aria-label="视频时长（秒）"
                aria-valuetext={formatSeconds(selectedValue)}
                className="video-duration-range h-8 w-full"
                style={{ accentColor: theme.accent.primary }}
                onChange={(event) => {
                    const nextValue = options[Number(event.target.value)];
                    if (nextValue !== undefined) onChange(nextValue);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <div className="flex justify-between px-0.5 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                <span>{options.length ? formatSeconds(options[0]!) : ""}</span>
                <span>{options.length ? formatSeconds(options[options.length - 1]!) : ""}</span>
            </div>
        </div>
    );
}

function DurationRangeControl({ value, min, max, step, theme, onChange, continuous }: { value: number; min: number; max: number; step: number | "any"; theme: CanvasTheme; onChange: (value: number) => void; continuous?: boolean }) {
    return (
        <div className="space-y-1.5">
            <div className="flex min-w-0 items-center gap-2">
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    aria-label="视频时长（秒）"
                    className="video-duration-range h-8 min-w-0 flex-1"
                    style={{ accentColor: theme.accent.primary }}
                    onChange={(event) => onChange(Number(event.target.value))}
                    onMouseDown={(event) => event.stopPropagation()}
                />
                <DurationInput value={value} min={min} max={max} theme={theme} onChange={onChange} continuous={continuous} />
            </div>
            <div className="flex justify-between px-0.5 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                <span>{min}s</span>
                <span>{max}s</span>
            </div>
        </div>
    );
}

function normalizeDurationValue(value: number, fallback: number, min: number, max: number, step: number) {
    const candidate = Number.isFinite(value) ? value : fallback;
    const clamped = Math.min(max, Math.max(min, Math.floor(candidate)));
    const maxStep = Math.max(0, Math.floor((max - min) / step));
    return min + Math.min(maxStep, Math.max(0, Math.round((clamped - min) / step))) * step;
}

function normalizedNumber(value: number) {
    return Number.isFinite(value) ? Math.floor(value) : 0;
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(7, Math.round((width / longSide) * 16));
    const previewHeight = Math.max(7, Math.round((height / longSide) * 16));
    return <span className="shrink-0 rounded-[2px] border" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    const parts = videoSizeLabel(ratio).match(/^(\d+):(\d+)$/);
    return parts ? { width: Number(parts[1]), height: Number(parts[2]) } : { width: 0, height: 0 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-2">
            <span className="min-w-0 whitespace-nowrap text-[var(--fs-label)]" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span className="shrink-0" onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="sm" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}
