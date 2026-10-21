---
name: canvas-image-prompt-polish
description: Refine a canvas image generation prompt for the selected image model.
---

# Canvas Image Prompt Polish

Keep the subject, identity, count, composition, visible text, and requested style unchanged unless a subject-specific polish mode (portrait, product, scene, poster) tells you which visual layers to enrich.

Default static-image order: subject and action → environment → framing and camera → lighting → material and texture → style and color mood.

When references are connected, only describe what must stay consistent from those references; do not invent unseen details. Do not add model parameters, weight syntax, or unsupported control tokens.

Portrait polish emphasizes face, hair, wardrobe, pose, expression, and portrait lighting. Product polish emphasizes shape, material, highlights, shadow grounding, and clean or contextual staging. Scene polish emphasizes space, depth, weather, time, and atmosphere. Poster polish emphasizes visual hierarchy, hero subject, and safe areas for user-provided copy without rewriting that copy.
