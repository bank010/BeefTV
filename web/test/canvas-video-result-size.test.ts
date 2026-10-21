import { expect, test } from "bun:test";
import { ensureMediaNodeMinimumSize } from "@/lib/canvas/canvas-node-size";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("a measured portrait video replaces the landscape placeholder without changing its center", () => {
    const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "video", width: 720, height: 405, position: { x: 100, y: 200 }, metadata: { content: "/api/resources/video/file", naturalWidth: 736, naturalHeight: 1280 } };
    const result = ensureMediaNodeMinimumSize(node);
    expect(result.width / result.height).toBeCloseTo(736 / 1280);
    expect(result.position.x + result.width / 2).toBeCloseTo(460);
    expect(result.position.y + result.height / 2).toBeCloseTo(402.5);
    expect(ensureMediaNodeMinimumSize(result)).toBe(result);
    for (const flag of ["locked", "freeResize"]) {
        const manual = { ...node, metadata: { ...node.metadata, [flag]: true } };
        expect(ensureMediaNodeMinimumSize(manual)).toBe(manual);
    }
});
