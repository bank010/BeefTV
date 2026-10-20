# MiniMax H3 Ref2VA Prompt Structure

Use the six sections below, in this exact order:

```text
subject_definitions: ...

summary: ...

retention_analysis: ...

detailed_description: ...

overall_soundscape: ...

non_diegetic_music: ...
```

## Reference labels

- `<Subject N>` identifies a reusable person, animal, object, scene, costume, style, action, or pose.
- `<Picture N>` identifies an image used as a frame, composition, or storyboard anchor.
- `<Video N>` identifies source footage or a temporal structure to continue or adapt.
- `<Audio N>` identifies sound to preserve or reference.

Assign labels by connected-reference order and keep each label's meaning stable in every section. Describe only contents the text model can observe. If media itself was not sent to the text model, identify it by the UI-provided reference label without claiming details about its unseen content.

## Section intent

- `subject_definitions`: define each tracked subject/reference and its role.
- `summary`: state the task, target duration, and relationships among references.
- `retention_analysis`: state what is preserved, adapted, transferred, or reused and where it appears.
- `detailed_description`: describe every shot in playback order, with composition, subject position, setting, lighting, state changes, camera movement, sound, dialogue, and when each reference takes effect.
- `overall_soundscape`: summarize ambience and physical sounds across the full video.
- `non_diegetic_music`: describe only background music unheard by characters.

Do not reduce `detailed_description` to a plot summary or reference list. Keep shot timing within the requested duration. Preserve dialogue, lyrics, and visible text verbatim.
