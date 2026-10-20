import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

import { devOwnerProxy } from "../dev-owner-proxy";

test("dev proxy authenticates only same-origin manual writes and preserves client identities", async () => {
    const directory = mkdtempSync(join(tmpdir(), "beeftv-dev-owner-"));
    const tokenFile = join(directory, "agent_owner_token");
    writeFileSync(tokenFile, "test-owner-one", { mode: 0o600 });
    const upstream = createHttpServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ owner: request.headers["x-beeftv-owner"] ?? null, client: request.headers["x-beeftv-client"] ?? null, origin: request.headers.origin ?? null }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as { port: number };
    const target = `http://127.0.0.1:${address.port}`;
    const server = await createServer({
        configFile: false, publicDir: false, root: directory,
        optimizeDeps: { noDiscovery: true, include: [] },
        plugins: [devOwnerProxy(target, tokenFile)],
        server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target, changeOrigin: true } } },
    });
    try {
        await server.listen();
        const port = (server.httpServer!.address() as { port: number }).port;
        const origin = `http://127.0.0.1:${port}`;
        const send = (headers: Record<string, string> = { Origin: origin }, path = "/api/ops/canvas.document.commit", method = "POST") => fetch(origin + path, { method, headers });
        expect(await (await send()).json()).toEqual({ owner: "test-owner-one", client: null, origin: target });
        expect(await (await send(undefined, "/api/assistant/ui-session")).json()).toEqual({ owner: "test-owner-one", client: null, origin: target });
        expect(await (await send(undefined, "/api/depth-captures")).json()).toEqual({ owner: "test-owner-one", client: null, origin: target });
        for (const headers of [{}, { Origin: "https://example.com" }, { Origin: "null" }, { Origin: "http://127.0.0.1:1" }]) {
            expect(await (await send(headers)).json()).toEqual({ owner: null, client: null, origin: "Origin" in headers ? headers.Origin : null });
        }
        for (const header of ["Authorization", "X-Beeftv-Client", "X-Beeftv-Agent-Token", "X-Desktop-Token", "X-Beeftv-UI-Bootstrap"]) {
            expect(await (await send({ Origin: origin, [header]: "external" })).json()).toEqual({ owner: null, client: null, origin });
        }
        expect(await (await send({ Origin: origin, "X-Beeftv-Owner": "explicit-owner" })).json()).toEqual({ owner: "explicit-owner", client: null, origin });
        expect(await (await send(undefined, "/api/tasks")).json()).toEqual({ owner: null, client: null, origin: null });
        expect(await (await send(undefined, "/api/ops/canvas.document.commit", "GET")).json()).toEqual({ owner: null, client: null, origin: null });
        writeFileSync(tokenFile, "test-owner-two");
        expect(await (await send()).json()).toEqual({ owner: "test-owner-two", client: null, origin: target });
        rmSync(tokenFile);
        const unavailable = await send();
        expect(unavailable.status).toBe(503);
        expect((await unavailable.json()).reason).toBe("local_credential_failed");
    } finally {
        await server.close();
        await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
        rmSync(directory, { recursive: true, force: true });
    }
}, 30_000);

test("dev owner proxy rejects remote upstreams before reading credentials", async () => {
    await expect(createServer({
        configFile: false,
        optimizeDeps: { noDiscovery: true, include: [] },
        plugins: [devOwnerProxy("https://example.com", "/unused-owner-token")],
        server: { middlewareMode: true },
    })).rejects.toThrow("requires a loopback API proxy target");
});
