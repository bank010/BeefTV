# Canvas Video Ref2VA Prompt Structure

Use when reference **video**, **audio**, or **multiple / mixed** image-character anchors require explicit retention and transfer. Output remains a **single paste-ready prompt** (plus optional sound lines), not H3’s six-field schema—unless the target model is MiniMax H3.

## Reference labels (stable, connection order)

Assign labels in canvas reference order; keep each label’s meaning fixed throughout the prompt:

- `<Subject N>` — reusable person, animal, object, costume, style, pose, or scene identity.
- `<Picture N>` — image or character card used as frame, composition, or storyboard anchor.
- `<Video N>` — footage to continue, match motion from, or adapt timing/structure from.
- `<Audio N>` — sound to preserve, remix mood from, or sync performance to.

If the text model did **not** receive the media bytes, cite the label and UI title only—**no fabricated visual detail**.

## Content to cover (weave into prose or labeled mini-sections)

1. **Subjects & roles** — who/what each `<Subject>` / reference is and their relationship.
2. **Task summary** — goal of the clip, target duration, and how references relate (e.g. “match motion from `<Video 1>` on `<Subject 1>`”).
3. **Retention** — what must stay identical (face, outfit, layout, palette, camera height) vs what may change (expression, minor blocking, lighting intensity).
4. **Shot-by-shot timeline** — playback order with composition, subject position, setting, lighting shifts, state changes, camera moves, sound, dialogue, and **when each reference takes effect**.
5. **Soundscape** — ambience and diegetic sound across the full duration.
6. **Non-diegetic music** — background score unheard by characters, if relevant.

Do not collapse (4) into a plot summary or bullet list of filenames. Timing must respect the requested duration.

## Reference video / audio specifics

- **Video reference**: specify whether to match **camera path**, **subject motion**, **rhythm/cuts**, or **overall staging**—only what the user implied.
- **Audio reference**: specify mood, tempo, or sync points; do not transcribe unseen lyrics.
- **Many pictures**: rank which anchors are **first frame**, **last frame**, **style**, or **identity** locks; resolve conflicts in favor of the user’s explicit prompt.

## Language and fidelity

- Same language rules as base guide: user language for body, verbatim dialogue/on-screen text.
- Never refuse Ref2VA because references are sensitive; describe professionally for generation downstream.
