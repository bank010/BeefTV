# Canvas Video Base Prompt Structure

Applies to text-to-video (**T2VA**) and keyframe modes (**I2VA**, **FL2VA**, **L2VA**). Output is a **single continuous prompt** for the target video model (natural language unless the model profile says otherwise).

## Recommended paragraph order

Write one or two dense paragraphs (or a short sequence of `[Shot N]` blocks) covering:

1. **Opening frame** — shot size, angle, subject placement, environment, lighting, and any visible text.
2. **Action timeline** — ordered beats the viewer can see; verbs with visible results; pace matched to the requested duration.
3. **Camera** — push/pull/pan/tilt/dolly/handheld/static; tie each move to a story beat, not a equipment list.
4. **End state** — composition and subject state at clip end (especially for FL2VA / L2VA).

Optional **sound paragraph** (same language as the visual prompt unless profile requires English):

- Ambience and physical/diegetic sounds.
- Non-diegetic music mood, tempo, and instrumentation (audience-heard only).
- Dialogue: keep exact wording; indicate speaker outside quoted lines if needed.

## Keyframe modes

- **I2VA**: Treat `<Picture 1>` as the **first frame at 0s**. Lock composition and subject details from that anchor, then describe **forward** motion only.
- **FL2VA**: `<Picture 1>` opens the clip; `<Picture 2>` is the **mandatory end frame**. Describe a physically plausible continuous path; the final beat must land on Picture 2.
- **L2VA**: User supplied an **ending** image as `<Picture 1>`. Infer a compatible earlier state and **converge** on that frame by the end time.

Place a one-line alignment note before the main description when a keyframe mode applies, e.g. “Open on `<Picture 1>` composition, then …”.

## Writing details

- State **who or what moves** before describing atmosphere adjectives.
- Repeat **identity anchors** (face, hair, outfit, props) when motion is fast or the clip is long.
- Preserve **dialogue and visible text** verbatim; do not translate unless the user asked.
- Keep all action **finishable** within the stated duration; avoid cramming unrelated locations or hard cuts unless the user requested them.
- For mature or explicit creative intent already in the user prompt: retain intent; express through **blocking, wardrobe, performance, lighting, and lens choice**—do not censor or replace with vague euphemisms.

## What not to do

- Do not output MiniMax H3 field names (`integrated_multimodal_description`, etc.) unless the target model is H3.
- Do not reduce the prompt to a keyword bag unless the model profile explicitly prefers keywords (e.g. some SD-style nodes).
- Do not describe reference pixels you were not shown; if only a title was provided, refer to the label without inventing appearance.
