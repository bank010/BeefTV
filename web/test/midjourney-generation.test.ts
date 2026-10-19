import { expect, test } from "bun:test";
import { canvasGenerationTaskNodes } from "@/pages/canvas/canvas-generation-failure";
import { defaultModelCapabilityConfig, normalizeImageValue } from "@/lib/model-capabilities";
import { CanvasNodeType } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

test("Midjourney exposes fixed four-image settings and tracks delivery for each candidate", () => {
    const profile = defaultModelCapabilityConfig("openai-image", "midjourney-v8.2").image!;
    expect(normalizeImageValue(profile, { count: "1", size: "16:9", quality: "high" })).toMatchObject({ count: "4", size: "1:1", quality: "auto" });
    const nodes = [0, 1].map((index) => ({ id: String(index), type: CanvasNodeType.Image, title: "MJ", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { taskOutputIndex: index, content: `image:${index}` } }));
    const task = { id: "task", type: "canvas_image", status: "succeeded", stage: "delivery_paused", outputs: [{ outputIndex: 0, materializedAssetId: "first" }, { outputIndex: 1, materializationErrorCode: "delivery_paused" }] } as GenerationTask;
    expect(canvasGenerationTaskNodes(nodes, "0", task)[0]!.metadata!.status).toBe("success");
    expect(canvasGenerationTaskNodes(nodes, "1", task)[1]!.metadata).toMatchObject({ status: "error", resourceReloadAvailable: true });
});

test("Midjourney creates one four-image task and preserves all output identities during recovery", async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/midjourney-generation.fixture.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("PASS: one paid task, four indexed outputs");
}, 15000);


test("Midjourney history reuses all four durable local assets", async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/midjourney-history.fixture.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("PASS: four local history outputs");
}, 15000);
