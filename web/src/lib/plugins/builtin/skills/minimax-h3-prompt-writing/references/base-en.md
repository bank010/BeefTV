# MiniMax H3 Base Prompt Structure

Applies to text-to-video (T2VA) and keyframe modes (I2VA, FL2VA, L2VA).

## Required section order

For T2VA, write these three fields in this order:

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

`integrated_multimodal_description` describes the visual and audible timeline, including actions, shots, dialogue, singing, and diegetic sound. `overall_soundscape` summarizes ambience and physical sounds. `non_diegetic_music` describes music heard by the audience but not by characters.

## Keyframe modes

- I2VA: make `<Picture 1>` the first frame at 0.00 seconds. Establish its composition and subject details, then describe continuous forward action.
- FL2VA: make `<Picture 1>` the opening and `<Picture 2>` the ending. Describe a plausible continuous path between them; the final state must land on Picture 2.
- L2VA: infer a compatible earlier state and converge on `<Picture 1>` at the requested end time.

Place the applicable alignment instruction before the three fields. Keep timings within the requested duration, and use sequential `[Shot N]` labels. Add a cut only when the prompt calls for a new viewpoint, space, state, or time.

## Writing details

Describe observable action in order. State who or what moves, how the camera moves, and how the scene ends. Keep identities, clothing, props, spatial relationships, and lighting consistent. Preserve dialogue and visible text verbatim and in their original language. Put dialogue content inside `<d>` with a language tag; keep speaker identification outside that block.

Use one concise paragraph of one to four English sentences for `overall_soundscape`. Use one to three English sentences for `non_diegetic_music`. Use `N/A` only when the user explicitly asks for silence or no background music.
