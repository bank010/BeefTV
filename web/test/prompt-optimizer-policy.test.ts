import { describe, expect, test } from "bun:test";
import { looksLikePromptPolishRefusal, PROMPT_OPTIMIZER_CREATIVE_POLICY, resolvePromptPolishSkill } from "@/lib/plugins/builtin/prompt-optimizer";
import { formatVideoPolishReferenceLines, resolveVideoPolishInputMode, videoPolishFocusBlock } from "@/lib/plugins/builtin/video-prompt-polish";

describe("prompt optimizer creative policy", () => {
    test("system policy forbids refusal and mentions adult creators", () => {
        expect(PROMPT_OPTIMIZER_CREATIVE_POLICY).toContain("禁止拒答");
        expect(PROMPT_OPTIMIZER_CREATIVE_POLICY).toContain("成年创作者");
        expect(PROMPT_OPTIMIZER_CREATIVE_POLICY).not.toContain("安全边界");
    });

    test("video expand mode attaches professional focus block", () => {
        expect(videoPolishFocusBlock("expand")).toContain("视频扩写专向");
        const skill = resolvePromptPolishSkill({
            prompt: "女人走进房间",
            mode: "expand",
            generationMode: "video",
            targetModel: "kling-v2",
        });
        expect(skill.instructions).toContain("视频扩写专向");
        expect(skill.instructions).toContain("拒答或道德评判");
        expect(skill.instructions).toContain("## Workflow");
        expect(skill.instructions).toContain("T2VA");
    });

    test("video input mode matches H3-style reference routing", () => {
        expect(resolveVideoPolishInputMode({ references: [] })).toBe("T2VA");
        expect(resolveVideoPolishInputMode({ references: [{ kind: "image" }] })).toBe("I2VA");
        expect(resolveVideoPolishInputMode({ references: [{ kind: "image" }, { kind: "image" }] })).toBe("FL2VA");
        expect(resolveVideoPolishInputMode({ references: [{ kind: "video" }] })).toBe("Ref2VA");
        expect(formatVideoPolishReferenceLines([{ kind: "video", title: "walk cycle" }])).toEqual(["- <Video 1> walk cycle (video)"]);
    });

    test("detects common polish refusals but not long prompts", () => {
        expect(looksLikePromptPolishRefusal("抱歉，我无法为你生成这类内容。")).toBe(true);
        expect(looksLikePromptPolishRefusal("I can't help with that request.")).toBe(true);
        expect(looksLikePromptPolishRefusal("")).toBe(true);
        const longPrompt = "Opening medium shot: a woman in a silk robe crosses a dim hotel suite, camera slowly tracks left as warm practicals flicker. ".repeat(20);
        expect(looksLikePromptPolishRefusal(longPrompt)).toBe(false);
    });
});
