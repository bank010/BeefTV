import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";

function isLoopback(host: string) {
    return ["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"].includes(host.toLowerCase());
}

function isManualLocalWrite(request: IncomingMessage) {
    if (request.method !== "POST" || !request.socket.remoteAddress || !isLoopback(request.socket.remoteAddress)) return false;
    const path = request.url?.split("?")[0];
    if (path !== "/api/assistant/ui-session" && !path?.startsWith("/api/ops/")) return false;
    // Never upgrade an external client or replace an explicitly supplied identity.
    if (["authorization", "x-beeftv-client", "x-beeftv-agent-token", "x-beeftv-owner", "x-desktop-token", "x-beeftv-ui-bootstrap"].some((name) => request.headers[name] !== undefined)) return false;
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!origin || !host) return false;
    try {
        const url = new URL(origin);
        return ["http:", "https:"].includes(url.protocol) && url.origin === origin && url.host === host && isLoopback(url.hostname);
    } catch {
        return false;
    }
}

/** Owner credentials stay in the dev server, never in VITE_* values or browser storage. */
export function devOwnerProxy(apiProxyTarget: string, tokenFile?: string): Plugin {
    return {
        name: "beeftv-dev-owner-proxy",
        apply: "serve",
        configureServer(server) {
            if (!tokenFile?.trim()) return;
            const target = new URL(apiProxyTarget);
            if (!isLoopback(target.hostname) || !["http:", "https:"].includes(target.protocol) || target.username || target.password) {
                throw new Error("BEEFTV_DEV_OWNER_TOKEN_FILE requires a loopback API proxy target");
            }
            const readToken = () => {
                const token = readFileSync(tokenFile, "utf8").trim();
                if (!token || /[\r\n]/.test(token)) throw new Error("Invalid local owner credential");
                return token;
            };
            readToken();
            server.middlewares.use((request, response, next) => {
                if (!isManualLocalWrite(request)) return next();
                try {
                    request.headers["x-beeftv-owner"] = readToken();
                } catch {
                    response.statusCode = 503;
                    response.setHeader("Content-Type", "application/json");
                    response.end(JSON.stringify({ code: 503, data: null, reason: "local_credential_failed", msg: "本地开发代理无法读取工作区凭据，请检查启动配置" }));
                    return;
                }
                next();
            });
        },
    };
}
