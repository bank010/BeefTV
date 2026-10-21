import type { PromptOptimizationMode } from "../plugin-types";

/** 仅用于文生图 / 图片节点的题材润色模式。 */
export const IMAGE_SUBJECT_POLISH_MODES = ["portrait", "product", "scene", "poster"] as const satisfies readonly PromptOptimizationMode[];

export type ImageSubjectPolishMode = (typeof IMAGE_SUBJECT_POLISH_MODES)[number];

const IMAGE_SUBJECT_SET = new Set<string>(IMAGE_SUBJECT_POLISH_MODES);

export function isImageSubjectPolishMode(mode: PromptOptimizationMode): mode is ImageSubjectPolishMode {
    return IMAGE_SUBJECT_SET.has(mode);
}

export type CanvasImagePolishMenuItem = {
    mode: PromptOptimizationMode;
    label: string;
    hint: string;
};

const CORE_IMAGE_POLISH_MENU: CanvasImagePolishMenuItem[] = [
    { mode: "expand", label: "扩展想法", hint: "从一句话补齐主体、场景、构图与光线" },
    { mode: "refine", label: "精修已有", hint: "保留原意，理顺表达并补必要细节" },
    { mode: "portrait", label: "人像润色", hint: "面部、发型、服装、姿态与光影，适合肖像与角色" },
    { mode: "product", label: "产品润色", hint: "材质、高光、背景与陈列，适合电商与静物" },
    { mode: "scene", label: "场景润色", hint: "空间、天气、氛围与环境叙事" },
    { mode: "poster", label: "海报版式", hint: "主视觉层级、留白与文字区域，不擅自改文案" },
    { mode: "style", label: "强化风格", hint: "在保留主体前提下加强艺术风格与质感" },
    { mode: "model-adapt", label: "适配模型", hint: "按当前图片模型习惯调整结构与措辞" },
];

export function canvasImagePolishMenuItems(options?: { hasReferences?: boolean }): CanvasImagePolishMenuItem[] {
    const items = [...CORE_IMAGE_POLISH_MENU];
    if (options?.hasReferences) {
        items.splice(2, 0, { mode: "reference", label: "结合参考", hint: "对齐已连接参考图/文本的一致性与可见细节" });
    }
    return items;
}

export function defaultCanvasImagePolishMode(): PromptOptimizationMode {
    return "expand";
}

export function canvasPolishShouldAttachReferenceImages(input: { generationMode: string; mode: PromptOptimizationMode; imageCount?: number }) {
    if (input.generationMode !== "image" || !input.imageCount) return false;
    return input.mode === "reference" || isImageSubjectPolishMode(input.mode);
}

export function imagePolishFocusBlock(mode: PromptOptimizationMode): string | undefined {
    switch (mode) {
        case "portrait":
            return [
                "## 人像润色专向",
                "目标：可执行的静态人像/角色画面描述，适合肖像、时尚、证件感、角色立绘与半身/全身人物。",
                "必须遵守：",
                "- 不改变人数、身份、年龄段、性别表达、种族/文化特征（若用户已写明）与关键面部识别点。",
                "- 补充：脸型与五官关系、发型与发饰、妆容或肤质质感、服装层次与配饰、体态与手部动作、视线方向、表情与情绪。",
                "- 写清：景别（特写/半身/全身）、机位高度、主光/辅光/轮廓光、背景虚化或环境简描。",
                "- 用户已写明的文字、Logo、水印位置保持原样，不新增品牌或标语。",
                "避免：把人像写成多镜头叙事；臆造参考图中看不见的细节；堆叠无意义的“高质量/8K”词。",
            ].join("\n");
        case "product":
            return [
                "## 产品润色专向",
                "目标：适合电商主图、静物、包装、3C、美妆、家具等单主体或少量组合的产品画面。",
                "必须遵守：",
                "- 不改变产品品类、数量、核心造型与用户指定的颜色/材质。",
                "- 补充：材质（金属/玻璃/织物等）、表面高光与反射、阴影落地、与支撑面/展台关系、背景干净度或场景化陈列。",
                "- 构图说明主体占比、拍摄角度（正面/45°/俯视）、是否需要对称或留白用于后期加字。",
                "- 品牌名、型号、包装上的文字仅保留用户原话，不伪造 Logo 或合规文案。",
                "避免：添加未要求的手模/模特抢戏；把产品描述改成抽象广告 slogan；使用未确认的工作流参数。",
            ].join("\n");
        case "scene":
            return [
                "## 场景润色专向",
                "目标：以环境、空间、时间与氛围为主的画面，人物/产品可为点缀但非唯一焦点。",
                "必须遵守：",
                "- 保留用户指定的地点类型、时代、天气、时间段与关键地标/室内布局。",
                "- 补充：空间纵深、前景/中景/背景层次、透视与引导线、环境光与空气感（雾、尘、雨等）。",
                "- 若有少量主体，说明其在场景中的位置与比例，不抢场景叙事。",
                "避免：把场景扩写成多格分镜；加入与时代/地理冲突的元素。",
            ].join("\n");
        case "poster":
            return [
                "## 海报 / 版式润色专向",
                "目标：宣传海报、封面、KV 等需要清晰视觉层级的静态画面。",
                "必须遵守：",
                "- 区分主视觉、次要元素与预留的文字/标题安全区；用户提供的标题/文案原文不改写、不翻译，只说明大致位置与层级。",
                "- 补充：构图重心、色彩对比、留白、边框或装饰元素的分布；摄影/插画/图形风格与用户意图一致。",
                "避免：擅自撰写新 slogan；把版式说明写成段落外的 UI 注释或 Markdown 列表输出到最终提示词。",
            ].join("\n");
        default:
            return undefined;
    }
}
