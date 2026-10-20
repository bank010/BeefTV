---
name: minimax-h3-prompt-writing
description: Rewrite video prompts for MiniMax H3 using its audiovisual field structure and stable multimodal reference labels. Use when the selected canvas video model is MiniMax H3 or an H3 style variant.
compatibility: Portable to any agent that can read local files. This skill requires no external API, MiniMax Hub tool, or proprietary runtime.
---

# MiniMax H3 Prompt Writing

This skill is bundled with BeefTV's video prompt optimizer and is applied automatically when the target video model is MiniMax H3.

## Workflow

1. Read the user's prompt, selected video duration, and ordered connected references.
2. Select one mode: T2VA for text only; I2VA for one opening image; FL2VA for opening and ending images; L2VA for a supplied ending image; Ref2VA for video/audio references or multiple mixed references.
3. Read `references/base-en.md` for T2VA and keyframe modes. Read `references/ref-en.md` for Ref2VA.
4. Preserve the user's requested subjects, actions, dialogue, visible text, duration, and reference intent. Do not invent reference contents that were not provided to the text model.
5. Return the complete prompt in the selected structure. Keep reference labels stable and ordered by the connected-reference order.

## Output rules

- Write prompt sections in English. Keep dialogue, lyrics, and visible text in their original language, verbatim.
- Use concrete visual and audible details: composition, subject, setting, action, camera, sound, and timing.
- Use `N/A` only where the selected H3 guide permits it; missing sound details do not mean the user requested silence.
- Do not add unsupported model parameters, negative-prompt syntax, or unrequested plot events.
- When structured output is requested, return a concise Chinese `changes` list explaining actual edits. For direct replacement, output only the complete prompt body.
