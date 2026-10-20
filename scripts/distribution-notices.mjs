import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const escapeHTML = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function distributionNotices({ root = repo, version, platform = "web", heavyMedia = true, sourcesDir = resolve(root, "dist") }) {
    if (!/^v?\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(version)) throw new Error("Invalid distribution version");
    version = `v${version.replace(/^v/, "")}`;
    if (!["web", "darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64"].includes(platform)) throw new Error("Invalid distribution platform");
    const files = new Map();
    for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) files.set(name, readFileSync(resolve(root, name)));
    for (const name of ["GPL-2.0.txt", "GPL-3.0.txt", "LGPL-2.1.txt"]) files.set(name, readFileSync(resolve(root, "licenses", name)));
    const required = [];
    if (heavyMedia) {
        const core = JSON.parse(readFileSync(resolve(root, "web/node_modules/@ffmpeg/core/package.json"), "utf8"));
        if (core.version !== "0.12.10" || core.license !== "GPL-2.0-or-later") throw new Error("FFmpeg.wasm changed; update its third-party notice");
        const wasm = readFileSync(resolve(root, "web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm"));
        const js = readFileSync(resolve(root, "web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js"));
        required.push({ id: "ffmpeg-wasm", version: core.version, license: core.license,
            binaryHashes: { wasm: sha256(wasm), javascript: sha256(js) },
            upstream: "https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1" });
    }
    if (platform.startsWith("darwin-")) required.push({ id: `ffprobe-${platform}`, version: "8.0.1", license: "LGPL-2.1-or-later",
        upstream: "https://github.com/FFmpeg/FFmpeg/tree/894da5ca7d742e4429ffb2af534fcda0103ef593" });
    if (platform === "windows-amd64") required.push({ id: "ffmpeg-windows-amd64", version: "8.0.1", license: "GPL-3.0-or-later",
        upstream: "https://www.gyan.dev/ffmpeg/builds/" });
    const components = required.map((component) => {
        // Only the locally built macOS ffprobe has a source packet in this pipeline.
        // Upstream project links are separate from corresponding-source delivery.
        if (!component.id.startsWith("ffprobe-darwin-")) return { ...component, source: null };
        const name = `BeefTV-${version}-${component.id}-sources.tar.gz`;
        const source = resolve(sourcesDir, name);
        const bytes = existsSync(source) ? readFileSync(source) : null;
        return { ...component, source: bytes ? { name, size: bytes.length, sha256: sha256(bytes),
            url: `https://github.com/glanderness/BeefTV/releases/download/${version}/${name}` } : null };
    });
    const index = { schema: 1, version, platform, components };
    files.set("sources.json", Buffer.from(JSON.stringify(index, null, 2) + "\n"));
    const links = components.map((component) => {
        const packet = component.source ? ` · <a href="${component.source.url}" target="_blank" rel="noopener noreferrer">本版本对应源码与构建说明</a>` : "";
        return `<li>${escapeHTML(component.id)} ${escapeHTML(component.version)} — ${escapeHTML(component.license)}<br><a href="${component.upstream}" target="_blank" rel="noopener noreferrer">上游项目与构建信息</a>${packet}</li>`;
    }).join("\n");
    files.set("index.html", Buffer.from(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BeefTV 第三方许可与源码</title>
<style>:root{color-scheme:light dark}body{font:15px/1.7 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 20px;color:CanvasText;background:Canvas;overflow-wrap:anywhere}h1{font-size:22px}ul{padding-left:24px}li{margin:16px 0}a{color:LinkText}a:focus-visible{outline:2px solid Highlight;outline-offset:3px}pre{white-space:pre-wrap}</style>
<h1>第三方许可与源码</h1><p>BeefTV ${escapeHTML(version)} 使用以下媒体组件。各组件继续适用自己的许可证；BeefTV 的商业使用限制不替代这些许可证。</p>
<ul>${links}</ul><p>各组件的使用、修改与再分发权利以其许可证为准。上游项目链接与本版本的对应源码包分别列出。</p>
<p><a href="GPL-2.0.txt">GPL 2.0</a> · <a href="GPL-3.0.txt">GPL 3.0</a> · <a href="LGPL-2.1.txt">LGPL 2.1</a></p>
<p><a href="LICENSE">BeefTV 许可</a> · <a href="NOTICE">版权声明</a> · <a href="THIRD_PARTY_NOTICES.md">第三方清单</a> · <a href="sources.json">版本与校验信息</a></p>
<script>
document.addEventListener("click", (event) => {
    const link = event.target.closest?.('a[href^="https://"]');
    if (!link) return;
    let runtime = window.runtime;
    try { runtime ||= window.parent.runtime; } catch { /* A browser may embed this page cross-origin. */ }
    if (typeof runtime?.BrowserOpenURL === "function") {
        event.preventDefault();
        runtime.BrowserOpenURL(link.href);
    }
});
</script></html>\n`));
    return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [platform, destination, version, sourcesDir] = process.argv.slice(2);
    if (!destination || !version) throw new Error(`Usage: ${basename(process.argv[1])} platform destination version [sources-dir]`);
    mkdirSync(destination, { recursive: true });
    for (const [name, bytes] of distributionNotices({ platform, version, sourcesDir, heavyMedia: process.env.BEEFTV_FULL_MEDIA_RESOURCES !== "0" })) writeFileSync(resolve(destination, name), bytes);
}
