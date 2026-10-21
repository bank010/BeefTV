import { describe, expect, test } from "bun:test";
import {
    canvasImagePolishMenuItems,
    canvasPolishShouldAttachReferenceImages,
    imagePolishFocusBlock,
    isImageSubjectPolishMode,
} from "@/lib/plugins/builtin/image-prompt-polish";
import { resolvePromptPolishSkill } from "@/lib/plugins/builtin/prompt-optimizer";

describe("image prompt polish presets", () => {
    test("menu includes subject modes and optional reference", () => {
        const base = canvasImagePolishMenuItems();
        expect(base.some((item) => item.mode === "portrait")).toBe(true);
        expect(base.some((item) => item.mode === "product")).toBe(true);
        expect(base.some((item) => item.mode === "scene")).toBe(true);
        expect(base.some((item) => item.mode === "poster")).toBe(true);
        expect(base.some((item) => item.mode === "reference")).toBe(false);
        expect(canvasImagePolishMenuItems({ hasReferences: true }).some((item) => item.mode === "reference")).toBe(true);
    });

    test("subject focus blocks are attached for image portrait polish", () => {
        expect(imagePolishFocusBlock("portrait")).toContain("人像润色");
        expect(isImageSubjectPolishMode("product")).toBe(true);
        const skill = resolvePromptPolishSkill({
            prompt: "一只咖啡杯",
            mode: "product",
            generationMode: "image",
            targetModel: "seedream-4",
        });
        expect(skill.instructions).toContain("产品润色专向");
        expect(skill.label).toContain("产品润色");
    });

    test("reference images attach for subject and reference modes", () => {
        expect(canvasPolishShouldAttachReferenceImages({ generationMode: "image", mode: "portrait", imageCount: 1 })).toBe(true);
        expect(canvasPolishShouldAttachReferenceImages({ generationMode: "image", mode: "expand", imageCount: 1 })).toBe(false);
        expect(canvasPolishShouldAttachReferenceImages({ generationMode: "video", mode: "portrait", imageCount: 1 })).toBe(false);
    });
});
