import { registerPlugin } from "../plugin-registry";
import type {
    PluginManifest,
    PluginTextContentPart,
    PluginTextMessage,
    PluginTextTool,
    PromptOptimizationInput,
    PromptOptimizationMode,
    PromptOptimizationResult,
    PromptOptimizationVariant,
    PromptOptimizerProvider,
    RegisteredPlugin,
} from "../plugin-types";
import { requestImageQuestion, requestToolResponse, type AiTextMessage, type ResponseFunctionTool } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import h3PromptWritingSkill from "./skills/minimax-h3-prompt-writing/SKILL.md?raw";
import h3BaseGuide from "./skills/minimax-h3-prompt-writing/references/base-en.md?raw";
import h3ReferenceGuide from "./skills/minimax-h3-prompt-writing/references/ref-en.md?raw";
import textPolishSkill from "./skills/canvas-text-prompt-polish/SKILL.md?raw";
import imagePolishSkill from "./skills/canvas-image-prompt-polish/SKILL.md?raw";
import videoPolishSkill from "./skills/canvas-video-prompt-polish/SKILL.md?raw";
import audioPolishSkill from "./skills/canvas-audio-prompt-polish/SKILL.md?raw";
import { isH3Model } from "@/lib/h3-video";
import { comfyUIWorkflowForModel } from "@/stores/use-config-store";

export const PROMPT_OPTIMIZER_PLUGIN_ID = "prompt-optimizer";

const modeLabels: Record<PromptOptimizationMode, string> = {
    expand: "扩展想法",
    refine: "精修已有提示词",
    style: "强化视觉风格",
    "model-adapt": "适配当前模型",
    reference: "结合参考素材",
};

const optimizerTool: PluginTextTool = {
    type: "function",
    function: {
        name: "optimize_prompt",
        description: "返回结构化的 AI 生图或生视频提示词优化结果。",
        strict: true,
        parameters: {
            type: "object",
            additionalProperties: false,
            required: ["optimizedPrompt", "negativePrompt", "changes", "assumptions", "variants"],
            properties: {
                optimizedPrompt: { type: "string", description: "可直接用于生成的正向提示词。" },
                negativePrompt: { type: "string", description: "需要规避的内容；没有时返回空字符串。" },
                changes: { type: "array", items: { type: "string" }, description: "相较输入提示词做出的关键变化。" },
                assumptions: { type: "array", items: { type: "string" }, description: "对模糊需求做出的假设；没有时返回空数组。" },
                variants: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["label", "prompt"],
                        properties: {
                            label: { type: "string" },
                            prompt: { type: "string" },
                        },
                    },
                    description: "最多两个可选的提示词版本。",
                },
            },
        },
    },
};

const manifest: PluginManifest = {
    id: PROMPT_OPTIMIZER_PLUGIN_ID,
    name: "AI 提示词优化器",
    version: "0.3.0",
    apiVersion: "beeftv.plugin/v1",
    description: "把模糊的生图想法整理成可执行、可比较、适配当前模型的提示词。",
    author: "内置工具",
    permissions: ["canvas.read", "canvas.write", "ai.text"],
    trusted: true,
    runtime: { web: "trusted-backend" },
    contributes: { aiCapabilities: ["prompt-optimizer"] },
};

const systemPrompt = [
    "你是当前创作工作台里的提示词导演，负责把用户模糊的视觉想法整理成可以直接交给生成模型的提示词。",
    "只优化表达和可执行性，不擅自改变用户明确写出的主体、身份、动作、数量、时代、地点、画幅比例或安全边界。",
    "优先使用具体可视化语言：主体与关系、构图与景别、动作、环境、材质、光线、色彩、镜头和风格。",
    "如果输入已经足够明确，保持原意并做克制的精修；如果信息不足，把不确定项写入 assumptions，不要假装知道。",
    "根据 generationMode 选择表达：文本侧重任务与输出要求，图片侧重静态画面，视频侧重连续动作，音频侧重声音与语音表现。",
    "根据目标节点和当前生成模型选择对应 Skill，并严格遵守模型适配策略；不要编造不存在的参数、权重语法或模型能力。",
    "最终必须调用 optimize_prompt 工具，不要输出 Markdown，不要在工具调用之外解释。",
].join("\n");

type ModelAdaptationProfile = {
    id: string;
    label: string;
    promptShape: string;
    rules: string[];
    avoid: string[];
};

const genericImageProfile: ModelAdaptationProfile = {
    id: "generic-image",
    label: "通用图片模型",
    promptShape: "自然语言描述，按主体与动作 → 环境 → 构图 → 光线与材质 → 风格排列。",
    rules: ["先锁定主体、数量、身份和动作，再补充可见的画面细节。", "把重要的比例、文字、位置和一致性要求写明确。"],
    avoid: ["不要臆造供应商参数或控制语法。", "关键规避项不要只放在 negativePrompt 中，正向提示词也要表达清楚。"],
};

const genericVideoProfile: ModelAdaptationProfile = {
    id: "generic-video",
    label: "通用视频模型",
    promptShape: "单镜头时序描述，按起始画面 → 主体动作 → 镜头运动 → 环境变化 → 结尾状态排列。",
    rules: ["每个动作使用可观察、连续的动词，避免一段话塞入互不相连的多个镜头。", "明确主体、镜头和环境谁在运动，并保持角色、服装和场景一致。"],
    avoid: ["不要把静态摄影参数堆成关键词列表。", "不要新增用户未要求的转场、角色或剧情。"],
};

const genericTextProfile: ModelAdaptationProfile = {
    id: "generic-text",
    label: "通用文本模型",
    promptShape: "按任务目标 → 必须保留的上下文 → 输出要求组织。",
    rules: ["明确用户希望模型完成的任务和交付形式。", "保留专有名词、原始事实、引用和语言要求。"],
    avoid: ["不要提前完成任务或补造背景事实。"],
};

const genericAudioProfile: ModelAdaptationProfile = {
    id: "generic-audio",
    label: "通用音频模型",
    promptShape: "按声音主体或台词 → 演绎方式 → 节奏与声学环境组织。",
    rules: ["保持原始台词、歌词、语言及说话人身份。", "只补充对声音生成有帮助的可听细节。"],
    avoid: ["不要增加用户未要求的台词、歌声或背景音乐。"],
};

function isH3PromptTarget(input: PromptOptimizationInput) {
    return input.generationMode === "video" && (isH3Model(input.targetModel || "") || /^minimax-h3(?:-reference)?$/.test(input.targetModelFamily || "") || /mini[\s_-]*max[\s_-]*h3/i.test(input.targetModel || ""));
}

export function promptPolishModelFamily(config: AiConfig, model: string): string | undefined {
    const workflow = comfyUIWorkflowForModel(config, model);
    if (!workflow || workflow.capability !== "video") return undefined;
    const nodes = Object.values(workflow.workflowJson || {});
    return nodes.some((value) => {
        if (!value || typeof value !== "object") return false;
        const node = value as Record<string, unknown>;
        return node.class_type === "MiniMaxH3ReferenceToVideo" || node.type === "MiniMaxH3ReferenceToVideo";
    }) ? "minimax-h3-reference" : undefined;
}

function containsAny(value: string, keywords: string[]) {
    return keywords.some((keyword) => value.includes(keyword));
}

function resolveModelAdaptationProfile(input: PromptOptimizationInput): ModelAdaptationProfile {
    const model = (input.targetModel || "").toLowerCase();
    if (input.generationMode === "text") {
        if (containsAny(model, ["claude", "anthropic"])) return { ...genericTextProfile, id: "claude-text", label: "Claude 文本模型", rules: [...genericTextProfile.rules, "把长任务分成明确步骤，并说明期望的输出结构。"] };
        if (containsAny(model, ["gemini", "google"])) return { ...genericTextProfile, id: "gemini-text", label: "Gemini 文本模型", rules: [...genericTextProfile.rules, "明确多模态或长上下文材料与输出之间的关系。"] };
        if (containsAny(model, ["deepseek"])) return { ...genericTextProfile, id: "deepseek-text", label: "DeepSeek 文本模型", rules: [...genericTextProfile.rules, "明确推理任务的目标、边界和可检查的结果。"] };
        if (containsAny(model, ["gpt", "openai"])) return { ...genericTextProfile, id: "openai-text", label: "OpenAI 文本模型", rules: [...genericTextProfile.rules, "使用直接的任务说明和清晰的输出约束。"] };
        return genericTextProfile;
    }
    if (input.generationMode === "audio") {
        if (containsAny(model, ["elevenlabs", "eleven-"])) return { ...genericAudioProfile, id: "elevenlabs-audio", label: "ElevenLabs 音频模型", rules: [...genericAudioProfile.rules, "用自然语言描述语气和停顿，保持台词原文。"] };
        if (containsAny(model, ["minimax", "speech-02"])) return { ...genericAudioProfile, id: "minimax-audio", label: "MiniMax 音频模型", rules: [...genericAudioProfile.rules, "明确需要的情绪、语速和发声方式，不改写台词。"] };
        if (containsAny(model, ["tts", "openai-audio", "gpt-4o-audio"])) return { ...genericAudioProfile, id: "speech-audio", label: "语音合成模型", rules: [...genericAudioProfile.rules, "把朗读内容与朗读方式分清楚。"] };
        return genericAudioProfile;
    }
    if (input.generationMode === "image") {
        if (containsAny(model, ["gemini", "imagen", "nano-banana", "nanobanana"])) {
            return {
                id: "gemini-image",
                label: "Gemini / Imagen 图片模型",
                promptShape: "清晰的自然语言场景描述，按主体 → 背景与上下文 → 风格与摄影细节组织。",
                rules: ["优先使用完整句子和具体视觉事实，参考图只描述确实可见的内容。", "如果画面含文字，保留原文并明确位置、层级和字数，避免无关装饰。", "控制提示词长度，先保留主体、上下文和风格这三个核心层次。"],
                avoid: ["不要使用 SD 权重、反向提示词标签或未确认的供应商参数。"],
            };
        }
        if (containsAny(model, ["gpt-image", "dall-e", "dalle", "openai-image", "openai"])) {
            return {
                id: "openai-image",
                label: "OpenAI 图片模型",
                promptShape: "简洁、完整的自然语言描述，先说要生成什么，再补充构图、光线、材质和风格。",
                rules: ["使用模型能直接理解的画面描述，不把提示词写成控制台参数。", "对画面中的文字、位置、数量和主体关系使用明确句子。"],
                avoid: ["不要添加 SD 权重、逗号关键词堆叠或 -- 参数。", "不要依赖单独 negativePrompt，重要限制要写进正向描述。"],
            };
        }
        if (containsAny(model, ["grok-image", "grok-imagine"])) {
            return {
                id: "grok-image",
                label: "Grok 图片模型",
                promptShape: "简洁的自然语言画面描述，主体、动作、环境和视觉风格清晰分层。",
                rules: ["保留明确的主体关系、构图和风格意图，避免把提示词写成参数清单。", "有参考图时说明要保留的主体或风格特征，不臆测看不见的细节。"],
                avoid: ["不要添加 SD 权重、Midjourney 参数或模型未确认支持的控制语法。"],
            };
        }
        if (containsAny(model, ["seedream", "jimeng", "doubao", "volcengine-ark-image", "volcengine-ark-agent-plan-image", "volcengine-jimeng-image"])) {
            return {
                id: "seedream-image",
                label: "Seedream / 即梦 / 火山图片模型",
                promptShape: "中文自然语言镜头描述，按主体与动作 → 构图 → 光影 → 材质与风格组织。",
                rules: ["优先写清人物或主体的外观、动作、空间关系和画面重点。", "需要人物一致性时重复关键外观特征，避免只写抽象的‘保持一致’。", "中文需求保持中文表达，英文专有名词只在确实有帮助时保留。"],
                avoid: ["不要套用 SD 的权重语法、质量词串或无意义的英文标签。", "不要把多个镜头和互相冲突的动作混在一条提示词里。"],
            };
        }
        if (containsAny(model, ["flux"])) {
            return {
                id: "flux-image",
                label: "FLUX 图片模型",
                promptShape: "自然语言段落 + 少量明确的视觉关键词，主体和动作放在前面。",
                rules: ["用具体关系描述主体、位置、材质和光线，而不是重复质量形容词。", "保留用户指定的风格和构图，不主动添加模型参数。"],
                avoid: ["不要输出很长的逗号标签清单或堆叠 negative prompt。", "不要添加未经用户要求的 LoRA、采样器或权重标记。"],
            };
        }
        if (containsAny(model, ["sdxl", "stable-diffusion", "stable diffusion", "sd3", "stable3"])) {
            return {
                id: "stable-diffusion-image",
                label: "Stable Diffusion / SDXL 图片模型",
                promptShape: "紧凑的分层关键词或短句，按主体 → 构图 → 光线 → 风格与质量组织。",
                rules: ["只保留能影响画面的关键词，主体和构图优先。", "如果原提示词已经使用括号权重，只在确有必要时保留并少量调整。", "将画面主体和反向规避项分开表达，避免互相冲突。"],
                avoid: ["不要盲目添加过多质量词、艺术家名或模型专属标签。", "不确定权重语法是否被当前渠道支持时，不要主动新增。"],
            };
        }
        if (containsAny(model, ["midjourney", "mid-journey"])) {
            return {
                id: "midjourney-image",
                label: "Midjourney 图片模型",
                promptShape: "精炼的视觉描述，主体、场景、构图和风格清晰，参数放在末尾。",
                rules: ["优先写画面内容和视觉方向，保持短而有辨识度。", "只有用户原本提供或明确要求时才保留 --ar、--stylize 等参数。"],
                avoid: ["不要臆造 Midjourney 参数或把所有摄影术语都堆上去。", "不要使用与当前工作台协议无关的命令前缀。"],
            };
        }
        if (containsAny(model, ["ideogram", "recraft"])) {
            return {
                id: "design-image",
                label: "设计与文字图片模型",
                promptShape: "先说明画布、主体和版式，再说明文字内容、位置、层级、字体气质和配色。",
                rules: ["画面文字保留精确原文并控制字数，明确文字与主体的空间关系。", "区分内容、版式和视觉风格，避免只给抽象审美词。"],
                avoid: ["不要擅自改写品牌名、标题、数字或标语。"],
            };
        }
        return genericImageProfile;
    }

    if (isH3PromptTarget(input)) {
        return {
            id: "minimax-h3-video",
            label: "MiniMax H3",
            promptShape: "按 H3 Skill 识别输入模式，并严格输出对应的视听提示词字段结构。",
            rules: ["按连接参考类型选择 T2VA、I2VA、FL2VA、L2VA 或 Ref2VA。", "保留官方字段顺序、Shot 编号、引用标签与时间格式。", "提示词正文按 Skill 用英文撰写，原始对白和画面文字保持原文。"],
            avoid: ["不要把 H3 的分段字段压成普通视频的一段式提示词。", "不要臆测文本模型不可见的参考素材内容。"],
        };
    }
    if (containsAny(model, ["seedance", "doubao-seedance", "volcengine-ark-video", "volcengine-ark-agent-plan-video", "volcengine-jimeng-video", "jimeng-video"])) {
        return {
            id: "seedance-video",
            label: "Seedance / 即梦视频模型",
            promptShape: "单镜头时序描述，明确起始构图、动作节拍、镜头运动、环境变化和结尾状态。",
            rules: ["用连续动作描述主体如何开始、发展和结束，保持镜头内的因果关系。", "人物、服装、场景和道具的一致性优先于堆叠风格词。", "有首帧或参考图时，明确哪些内容必须保持、哪些内容允许变化。"],
            avoid: ["不要在一条提示词中拼接多个无关镜头。", "不要把静态图片参数当成视频动作指令。"],
        };
    }
    if (containsAny(model, ["veo", "gemini-veo"])) {
        return {
            id: "veo-video",
            label: "Veo 视频模型",
            promptShape: "电影化的自然语言镜头描述，按主体、动作、镜头、环境和节奏组织。",
            rules: ["把想法拆成可观察的动作和镜头运动，并补充时间顺序。", "用景别、机位、运镜、光线和环境声等可视化要素控制镜头。"],
            avoid: ["不要只写情绪和抽象风格，不给动作或镜头变化。", "不要加入用户未要求的多镜头转场。"],
        };
    }
    if (containsAny(model, ["kling"])) {
        return {
            id: "kling-video",
            label: "Kling 视频模型",
            promptShape: "简洁、连续的动作指令，明确主体运动和摄像机运动。",
            rules: ["每个动作都写清主体、方向、速度或结果，避免互相冲突的动作。", "优先保证物理连续性、角色一致性和镜头稳定。"],
            avoid: ["不要加入过多抽象叙事或无法在短片段中完成的事件。"],
        };
    }
    if (containsAny(model, ["runway", "gen-3", "gen3"])) {
        return {
            id: "runway-video",
            label: "Runway 视频模型",
            promptShape: "以单个镜头为单位描述起始画面、动作过程、摄影机和结束画面。",
            rules: ["动作使用连续动词，明确运动主体和摄像机，不把结果写成静态形容词。", "保持角色、服装、场景和光线的连续性。"],
            avoid: ["不要堆砌静态图片关键词或一次安排过多动作。"],
        };
    }
    if (containsAny(model, ["minimax-video", "hailuo"])) return { ...genericVideoProfile, id: "hailuo-video", label: "海螺视频模型", rules: [...genericVideoProfile.rules, "描述一个可在当前时长内完成的清晰动作过程。"] };
    if (containsAny(model, ["wan"])) return { ...genericVideoProfile, id: "wan-video", label: "Wan 视频模型", rules: [...genericVideoProfile.rules, "把参考画面与运动方向、变化范围对应起来。"] };
    if (containsAny(model, ["ltx-video"])) return { ...genericVideoProfile, id: "ltx-video", label: "LTX 视频模型", rules: [...genericVideoProfile.rules, "优先保留最重要的镜头动作，避免互相竞争的视觉目标。"] };
    if (containsAny(model, ["hunyuan-video"])) return { ...genericVideoProfile, id: "hunyuan-video", label: "混元视频模型", rules: [...genericVideoProfile.rules, "明确主体、场景与镜头的时序关系。"] };
    return genericVideoProfile;
}

export function resolvePromptPolishSkill(input: PromptOptimizationInput) {
    const profile = resolveModelAdaptationProfile(input);
    const h3 = isH3PromptTarget(input);
    const baseSkills = {
        text: textPolishSkill,
        image: imagePolishSkill,
        video: videoPolishSkill,
        audio: audioPolishSkill,
    };
    const id = h3 ? "minimax-h3-prompt-writing" : `canvas-${input.generationMode}-prompt-polish/${profile.id}`;
    const label = h3 ? "MiniMax H3" : profile.label;
    const instructions = [
        h3 ? h3PromptWritingSkill : baseSkills[input.generationMode],
        `当前模型适配 Skill：${profile.label} (${profile.id})`,
        `建议结构：${profile.promptShape}`,
        "必须遵守：",
        ...profile.rules.map((rule) => `- ${rule}`),
        "避免：",
        ...profile.avoid.map((rule) => `- ${rule}`),
    ].join("\n");
    return { id, label, instructions, profile, h3 };
}

function buildUserMessage(input: PromptOptimizationInput, modelProfile: ModelAdaptationProfile | null = resolveModelAdaptationProfile(input), toolOutput = true, includeImageAttachments = toolOutput): PluginTextMessage {
    const skill = resolvePromptPolishSkill(input);
    const useH3Skill = skill.h3;
    const h3References = (input.context?.references || []).filter((reference) => reference.kind === "image" || reference.kind === "character" || reference.kind === "video" || reference.kind === "audio");
    const pictureCount = h3References.filter((reference) => reference.kind === "image" || reference.kind === "character").length;
    const videoCount = h3References.filter((reference) => reference.kind === "video").length;
    const audioCount = h3References.filter((reference) => reference.kind === "audio").length;
    const h3Mode = input.targetModelFamily === "minimax-h3-reference" || videoCount + audioCount > 0 || pictureCount > 2
        ? "Ref2VA"
        : pictureCount === 2
            ? "FL2VA"
            : pictureCount === 1
                ? "I2VA"
                : "T2VA";
    const h3Guide = h3Mode === "Ref2VA" ? h3ReferenceGuide : h3BaseGuide;
    const textParts = [
        `优化模式：${modeLabels[input.mode]}`,
        `目标类型：${({ text: "文本", image: "图片", video: "视频", audio: "音频" } as const)[input.generationMode]}`,
        `选用 Skill：${skill.id}`,
        `目标生成模型：${input.targetModel?.trim() || "未指定"}`,
        `目标接口协议：${input.targetProtocol?.trim() || "未指定"}`,
        ...(useH3Skill ? [`目标视频时长：${input.targetDuration?.trim() || "未指定"} 秒`] : []),
        "",
        "用户原始提示词：",
        input.prompt.trim() || "（用户还没有写出具体提示词，请从参考上下文中提炼一个可执行版本）",
    ];
    if (useH3Skill) {
        textParts.push(
            "",
            `本次 H3 输入模式：${h3Mode}`,
            "Skill 参考规范：",
            h3Guide,
        );
        if (h3References.length) {
            textParts.push(
                "",
                "连接的 H3 参考素材（按画布参考顺序编号；不要推测看不见的内容）：",
                ...h3References.map((reference, index) => {
                    const label = reference.kind === "video" ? "Video" : reference.kind === "audio" ? "Audio" : "Picture";
                    return `- <${label} ${h3References.slice(0, index + 1).filter((item) => (item.kind === "video" ? "Video" : item.kind === "audio" ? "Audio" : "Picture") === label).length}> ${reference.title} (${reference.kind})`;
                }),
            );
        }
    }
    if (modelProfile) {
        textParts.push(
            "",
            `模型适配策略：${modelProfile.label}`,
            `建议提示词结构：${modelProfile.promptShape}`,
            "必须遵守：",
            ...modelProfile.rules.map((rule) => `- ${rule}`),
            "避免：",
            ...modelProfile.avoid.map((rule) => `- ${rule}`),
            "请在 changes 中明确说明已经采用的模型适配要点。",
        );
    }
    if (input.context?.texts?.length) {
        textParts.push("", "已连接的文本上下文：", ...input.context.texts.map((item) => `- ${item.title}：${item.text}`));
    }
    if (input.context?.images?.length) {
        textParts.push(
            "",
            includeImageAttachments ? "已连接的参考图已作为图片输入，请只在确实可见的内容上做判断：" : "已连接的参考图（当前请求只提供素材名称，不读取图片内容）：",
            ...input.context.images.map((item) => `- ${item.title}`),
        );
    }
    textParts.push("", "输出要求：");
    if (toolOutput) {
        textParts.push(
            "1. optimizedPrompt 是一段可以直接复制到当前生成节点的提示词。",
            "2. negativePrompt 只填写明确有帮助的规避项，没有就留空。",
            "3. changes 和 assumptions 使用简短中文条目。",
            "4. variants 最多给出两个明显不同但仍忠于原意的版本，没有必要时返回空数组。",
        );
    } else {
        textParts.push("只输出 optimizedPrompt 的完整正文，不输出字段名、JSON、Markdown 围栏、解释或其他内容。保留原意，确保结果可以直接用于当前生成节点。");
    }
    if (useH3Skill) {
        textParts.push(
            ...(toolOutput ? [
                "5. optimizedPrompt 必须是可直接用于 MiniMax H3 的完整字段结构；不能省略字段名或改变字段顺序。",
                "6. changes 简要记录识别出的模式、补齐的时序/镜头/声音信息和引用对齐；不声称看到了不可见素材。",
                "7. 对 T2VA/I2VA/FL2VA 使用 integrated_multimodal_description、overall_soundscape、non_diegetic_music；对 Ref2VA 使用其六个规定字段。",
            ] : [
                "H3 输出必须保留 Skill 规定的完整字段名、顺序和格式；T2VA/I2VA/FL2VA 使用 integrated_multimodal_description、overall_soundscape、non_diegetic_music，Ref2VA 使用其六个规定字段。",
            ]),
        );
    }

    const content: PluginTextContentPart[] = [{ type: "text", text: textParts.join("\n") }];
    if (includeImageAttachments) {
        for (const image of input.context?.images || []) {
            if (/^(data:|https?:\/\/)/i.test(image.url.trim())) content.push({ type: "image_url", image_url: { url: image.url.trim() } });
        }
    }
    return { role: "user", content };
}

function parseJsonObject(value: string) {
    const cleaned = value
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    const candidates = [cleaned];
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
    for (const candidate of candidates) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
            // 某些兼容模型会在 JSON 外包一层解释，继续尝试截取对象部分。
        }
    }
    return null;
}

function stringArray(value: unknown) {
    return Array.isArray(value)
        ? value
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
        : [];
}

function variants(value: unknown): PromptOptimizationVariant[] {
    if (!Array.isArray(value)) return [];
    return value
        .flatMap((item): PromptOptimizationVariant[] => {
            if (!item || typeof item !== "object") return [];
            const record = item as Record<string, unknown>;
            const label = typeof record.label === "string" ? record.label.trim() : "备选版本";
            const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
            return prompt ? [{ label: label || "备选版本", prompt }] : [];
        })
        .slice(0, 2);
}

function normalizeResult(value: Record<string, unknown> | null, sourcePrompt: string, modelProfile?: ModelAdaptationProfile | null): PromptOptimizationResult {
    const optimizedPrompt = typeof value?.optimizedPrompt === "string" ? value.optimizedPrompt.trim() : "";
    const negativePrompt = typeof value?.negativePrompt === "string" ? value.negativePrompt.trim() : "";
    return {
        optimizedPrompt: optimizedPrompt || sourcePrompt.trim(),
        negativePrompt,
        changes: stringArray(value?.changes),
        assumptions: stringArray(value?.assumptions),
        variants: variants(value?.variants),
        modelProfile: modelProfile ? { id: modelProfile.id, label: modelProfile.label } : undefined,
    };
}

function createPromptOptimizer(context: Parameters<NonNullable<RegisteredPlugin["createPromptOptimizer"]>>[0]): PromptOptimizerProvider {
    const textService = context.services?.ai?.text;
    if (!textService) throw new Error("提示词优化器暂未获得文本模型服务");

    return {
        optimize: async (input, options) => {
            const skill = resolvePromptPolishSkill(input);
            const modelProfile = skill.profile;
            const response = await textService.requestToolResponse({
                model: input.optimizerModel,
                messages: [{ role: "system", content: [systemPrompt, skill.instructions].join("\n\n") }, buildUserMessage(input, modelProfile)],
                tools: [optimizerTool],
                toolChoice: { type: "function", name: "optimize_prompt" },
                signal: options?.signal,
                onDelta: options?.onDelta,
            });
            const toolCall = response.toolCalls.find((call) => call.name === "optimize_prompt");
            const parsed = parseJsonObject(toolCall?.arguments || response.content);
            return normalizeResult(parsed, input.prompt, modelProfile);
        },
    };
}

export async function optimizePromptWithConfig(
    config: AiConfig,
    input: PromptOptimizationInput,
    options?: { signal?: AbortSignal; onDelta?: (text: string) => void },
): Promise<PromptOptimizationResult> {
    const model = input.optimizerModel?.trim() || config.textModel.trim();
    if (!model) throw new Error("请先在模型设置中选择文本模型");
    const skill = resolvePromptPolishSkill(input);
    const modelProfile = skill.profile;
    const system = [systemPrompt.replace("最终必须调用 optimize_prompt 工具，不要输出 Markdown，不要在工具调用之外解释。", "最终只输出润色后的提示词正文，不输出字段名、JSON、Markdown 围栏或解释。"), skill.instructions].join("\n\n");
    const response = await requestImageQuestion(
        { ...config, model, textModel: model },
        [{ role: "system", content: system }, buildUserMessage(input, modelProfile, false, false) as unknown as AiTextMessage],
        options?.onDelta || (() => undefined),
        { signal: options?.signal },
    );
    const optimizedPrompt = response.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (!optimizedPrompt) throw new Error("文本模型没有返回润色后的提示词");
    return normalizeResult({ optimizedPrompt }, input.prompt, modelProfile);
}

export const promptOptimizerPlugin: RegisteredPlugin = {
    manifest,
    createPromptOptimizer,
};

registerPlugin(promptOptimizerPlugin);
