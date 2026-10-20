type H3ReferenceKind = "image" | "character" | "video" | "audio" | "text" | "skill";

export function h3ReferenceEntries<T>(items: T[], kindOf: (item: T) => H3ReferenceKind) {
    const counts = { Picture: 0, Video: 0, Audio: 0 };
    return items.flatMap((item) => {
        const kind = kindOf(item);
        const label = kind === "image" || kind === "character" ? "Picture" : kind === "video" ? "Video" : kind === "audio" ? "Audio" : null;
        if (!label) return [];
        return [{ item, token: `<${label} ${++counts[label]}>` }];
    });
}
