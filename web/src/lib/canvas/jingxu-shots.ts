// Ported from 镜序分镜工具/server.py: keep source-frame timestamps and
// retain the strongest cut when candidates are within 450 ms.
export type JingxuShot = { start: number; end: number; desc: string };
export type JingxuCut = { t: number; score: number };

export function jingxuShots(candidates: JingxuCut[], duration: number): JingxuShot[] {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长");
    const selected: JingxuCut[] = [];
    for (const cut of [...candidates].sort((a, b) => a.t - b.t)) {
        if (!Number.isFinite(cut.t) || !Number.isFinite(cut.score) || cut.t <= .08 || cut.t >= duration - .08) continue;
        const previous = selected.at(-1);
        if (!previous || cut.t - previous.t > .45) selected.push(cut);
        else if (cut.score > previous.score) selected[selected.length - 1] = cut;
    }
    const cuts = [0, ...selected.map((cut) => cut.t), duration];
    return cuts.slice(0, -1).map((start, index) => ({ start, end: cuts[index + 1], desc: "" }));
}

