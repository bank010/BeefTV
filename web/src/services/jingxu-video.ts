import { withFFmpegLease } from "@/lib/canvas/canvas-ffmpeg-session";
import { readVideoSourceBlob, type VideoSegmentSource } from "@/lib/canvas/canvas-video-segment";
import { jingxuShots, type JingxuCut, type JingxuShot } from "@/lib/canvas/jingxu-shots";
import { assertUsableSegmentOutput } from "@/lib/canvas/canvas-video-segment-args";

const bytes = (value: Uint8Array | string) => typeof value === "string" ? new TextEncoder().encode(value) : value;

/** 镜序逐帧检测与逐段输出，共用画布 FFmpeg 队列，每段保存后释放临时文件。 */
export async function splitJingxuVideo(source: VideoSegmentSource, options: {
    signal: AbortSignal;
    onProgress: (message: string) => void;
    onDetected: (shots: JingxuShot[]) => void;
    onEncoding: (index: number) => void;
    onShot: (blob: Blob, shot: JingxuShot, index: number, total: number) => Promise<void>;
}) {
    const { signal, onProgress, onShot } = options;
    return withFFmpegLease(async ({ ffmpeg, filePrefix }) => {
        const input = `${filePrefix}jingxu-input`, probe = `${filePrefix}probe.json`, clip = `${filePrefix}shot.mp4`;
        let pendingTime = 0, duration = 0, lastProgress = -1;
        const candidates: JingxuCut[] = [];
        const log = ({ message }: { message: string }) => {
            const timestamp = message.match(/pts_time:([-+0-9.eE]+)/);
            if (timestamp) {
                pendingTime = Number(timestamp[1]);
                const percent = Math.min(100, Math.floor(pendingTime / duration * 100));
                if (percent > lastProgress) { lastProgress = percent; onProgress(`正在检测镜头 ${percent}%`); }
            }
            const score = message.match(/lavfi\.scene_score=([-+0-9.eE]+)/);
            if (score) candidates.push({ t: pendingTime, score: Number(score[1]) });
        };
        try {
            onProgress("正在读取视频");
            const sourceBlob = await readVideoSourceBlob(source, signal);
            await ffmpeg.writeFile(input, new Uint8Array(await sourceBlob.arrayBuffer()));
            signal.throwIfAborted();
            const code = await ffmpeg.ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "json", input, "-o", probe]);
            if (code !== 0 && code !== -1) throw new Error("无法读取视频信息");
            duration = Number(JSON.parse(new TextDecoder().decode(bytes(await ffmpeg.readFile(probe)))).format?.duration);
            if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长无效");
            ffmpeg.on("log", log);
            // 复用镜序默认 0.19 阈值，逐帧扫描，避免抽样使切点偏移。
            const scan = await ffmpeg.exec(["-hide_banner", "-loglevel", "info", "-i", input, "-vf", "scale=320:-2,showinfo,select='gt(scene,0.19)',metadata=print", "-an", "-sn", "-dn", "-f", "null", "-"]);
            ffmpeg.off("log", log);
            if (scan !== 0) throw new Error("镜头检测失败，请检查视频格式");
            const shots = jingxuShots(candidates, duration);
            if (shots.length > 1000) throw new Error("检测到超过 1000 个镜头，请先截取部分视频再自动分镜");
            options.onDetected(shots);
            for (const [index, shot] of shots.entries()) {
                signal.throwIfAborted();
                options.onEncoding(index);
                onProgress(`正在生成镜头 ${index + 1}/${shots.length}`);
                const encoded = await ffmpeg.exec(["-y", "-ss", String(shot.start), "-i", input, "-t", String(shot.end - shot.start), "-map", "0:v:0", "-map", "0:a?", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", clip]);
                if (encoded !== 0) throw new Error(`镜头 ${index + 1} 视频切分失败`);
                const output = await ffmpeg.readFile(clip);
                assertUsableSegmentOutput(output, "video");
                const blob = new Blob([bytes(output) as BlobPart], { type: "video/mp4" });
                await ffmpeg.deleteFile(clip);
                signal.throwIfAborted();
                await onShot(blob, shot, index, shots.length);
            }
            return shots.length;
        } finally {
            ffmpeg.off("log", log);
            await Promise.all([input, probe, clip].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { signal, onProgress: () => onProgress("正在加载视频工具") });
}
