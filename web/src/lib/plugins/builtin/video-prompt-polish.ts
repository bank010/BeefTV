import type { PromptOptimizationMode } from "../plugin-types";

export type VideoPolishInputMode = "T2VA" | "I2VA" | "FL2VA" | "Ref2VA";

export function resolveVideoPolishInputMode(input: {
    targetModelFamily?: string;
    references?: Array<{ kind: string }>;
}): VideoPolishInputMode {
    const refs = (input.references || []).filter((reference) =>
        reference.kind === "image" || reference.kind === "character" || reference.kind === "video" || reference.kind === "audio",
    );
    const pictureCount = refs.filter((reference) => reference.kind === "image" || reference.kind === "character").length;
    const videoCount = refs.filter((reference) => reference.kind === "video").length;
    const audioCount = refs.filter((reference) => reference.kind === "audio").length;
    if (input.targetModelFamily === "minimax-h3-reference" || videoCount + audioCount > 0 || pictureCount > 2) {
        return "Ref2VA";
    }
    if (pictureCount === 2) return "FL2VA";
    if (pictureCount === 1) return "I2VA";
    return "T2VA";
}

export function formatVideoPolishReferenceLines(references: Array<{ kind: string; title: string }>): string[] {
    const active = references.filter((reference) =>
        reference.kind === "image" || reference.kind === "character" || reference.kind === "video" || reference.kind === "audio",
    );
    return active.map((reference, index) => {
        const label = reference.kind === "video" ? "Video" : reference.kind === "audio" ? "Audio" : "Picture";
        const ordinal = active.slice(0, index + 1).filter((item) => {
            const itemLabel = item.kind === "video" ? "Video" : item.kind === "audio" ? "Audio" : "Picture";
            return itemLabel === label;
        }).length;
        return `- <${label} ${ordinal}> ${reference.title} (${reference.kind})`;
    });
}

export function videoPolishFocusBlock(mode: PromptOptimizationMode): string | undefined {
    switch (mode) {
        case "expand":
            return [
                "## 视频扩写专向",
                "目标：把短句扩成单镜头、可执行的连续影像描述，适合分镜预演与 AI 视频生成。",
                "必须遵守：",
                "- 保留用户写明的角色数量、关系、年龄段、服装状态、动作意图、场景与时代；不擅自「净化」或弱化用户已给出的尺度与表演要求。",
                "- 用专业影视语言补全：起始构图 → 主体动作节拍 → 镜头运动（推/拉/摇/移/跟/升降）→ 环境变化 → 结尾画面；区分「人物运动」与「摄影机运动」。",
                "- 写清光线方向、色温、景深、材质与氛围；需要连贯性时重复关键外观锚点（发型、服装、道具）。",
                "- 时长感：动作应在当前片段时长内可完成，避免塞入多段硬切。",
                "避免：拒答或道德评判；把视频写成静态摄影参数清单；臆造用户未要求的额外角色、台词或剧情转折。",
            ].join("\n");
        case "refine":
            return [
                "## 视频精修专向",
                "目标：在不改意的前提下理顺时序、动词与镜头表述，让模型更容易执行。",
                "必须遵守：",
                "- 原提示词中的主体、动作、尺度与禁忌项全部保留；只改表达顺序、重复冗余和互相冲突的运动描述。",
                "- 每个动词对应可观察画面变化；删掉空泛形容词，换成可见结果（如「紧张」→「肩线绷紧、呼吸加快、视线游移」）。",
                "避免：删减用户刻意保留的敏感或成人向描述；合并成无法在一镜内完成的多个场景。",
            ].join("\n");
        case "style":
            return [
                "## 视频风格强化专向",
                "目标：在保留动作与主体不变的前提下，加强摄影风格、色彩脚本、胶片/数字质感与声音环境暗示。",
                "必须遵守：",
                "- 风格词必须落到可见要素：对比度、颗粒、快门感、调色倾向、光源性质、镜头焦段感。",
                "- 不改动用户设定的叙事与表演内容。",
                "避免：用抽象审美词替代具体镜头信息。",
            ].join("\n");
        case "reference":
            return [
                "## 视频参考对齐专向",
                "目标：让运动与构图对齐已连接参考，只描述需要保持一致或从参考延续的部分。",
                "必须遵守：",
                "- 参考图/视频/文本里未出现的内容不臆造；写清「保持/延续/变化」的边界。",
                "- 说明哪些身份特征、服装、场景布局必须锁死，哪些允许在动作中变化。",
                "避免：声称看见了未提供的素材细节。",
            ].join("\n");
        default:
            return undefined;
    }
}
