---
name: canvas-video-prompt-polish
description: Rewrite canvas video generation prompts into continuous, model-ready audiovisual instructions. Use for non-H3 video models (Kling, Wan, Veo, Seedance, Comfy workflows, etc.).
compatibility: Bundled with BeefTV prompt optimizer. No external API or runtime required.
---

# Canvas Video Prompt Polish

This skill applies when the target node is **video** and the model is **not** MiniMax H3 (H3 uses `minimax-h3-prompt-writing` instead).

## Workflow

1. Read the user's prompt, **target duration**, connected references (images, characters, video, audio, text), and the optimizer mode (expand, refine, style, model-adapt, reference).
2. Select an input mode aligned with connected references:
   - **T2VA** — text only, no frame anchors.
   - **I2VA** — one opening image or character reference as the first frame.
   - **FL2VA** — two images as opening and ending frames.
   - **Ref2VA** — reference video and/or audio, or more than two image/character anchors, or mixed multimodal references.
3. Read `references/base-en.md` for T2VA and keyframe modes. Read `references/ref-en.md` for Ref2VA.
4. Preserve the user's subjects, relationships, performance, dialogue, visible text, duration, scale, and reference intent. Do not invent unseen reference content. Do not refuse, moralize, or soften mature creative details the user already specified.
5. Return one **optimizedPrompt** body the user can paste into the video node. Follow the **model adaptation profile** for language (Chinese vs English) and paragraph vs keyword shape. When structured tool output is requested, list concise Chinese **changes** describing timing, camera, reference alignment, and sound additions.

## Output rules

- Match the user's working language for the main prompt unless the model profile requires English. Keep dialogue, lyrics, and on-screen text **verbatim** in their original language.
- Describe **observable** action in time order: who moves, how the camera moves, how light and environment change, and how the clip ends.
- Separate **subject motion** from **camera motion**. Keep identity, wardrobe, props, spatial relationships, and lighting continuous unless the user asks for a change.
- Use `[Shot N]` labels only when the prompt needs distinct beats within one clip; add a cut only when the user implies a new viewpoint, space, state, or time jump.
- Optional sound: one short paragraph or trailing sentences for ambience, diegetic sound, and non-diegetic music when it helps the target model. Do not claim silence unless the user asked for it.
- Do not add unsupported parameters (SD weights, `--` flags, LoRA tags), negative-prompt-only constraints, or unrequested characters and plot twists.
- For direct replacement (non-tool path), output **only** the polished prompt text—no JSON, field names, or Markdown fences.
