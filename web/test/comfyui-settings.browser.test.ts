import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";

test("ComfyUI 单项草稿、保存确认、失败重试与刷新恢复，明暗主题及窄屏可用", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/comfyui-settings-harness.tsx"], target: "browser", define: {
        "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
    }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        // Use the real picker with fallback icons; Vite's lazy asset glob is unavailable in Bun builds.
        builder.onLoad({ filter: /\/model-logo\.tsx$/ }, (args) => ({ contents: readFileSync(args.path, "utf8").replace("import.meta.glob(", "(() => ({}))("), loader: "tsx" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const cssPath = import.meta.dir + "/../src/styles/globals.css";
    const css = (await postcss([tailwind({ base: import.meta.dir + "/.." })]).process(readFileSync(cssPath, "utf8"), { from: cssPath })).css
        + readFileSync(import.meta.dir + "/../src/styles/beeftv-local-overrides.css", "utf8")
        + readFileSync(import.meta.dir + "/../src/styles/workspace-product.css", "utf8");
    let stored: AiConfig;
    let revision = 1;
    let failSave = false;
    let failParse = false;
    const writes: AiConfig[] = [];
    const reads: { file: string; capability: string }[] = [];
    const unexpected: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(request) {
        const url = new URL(request.url);
        const ok = (data: unknown) => Response.json({ code: 0, data });
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (url.pathname === "/api/workspace/model-config") {
            if (request.method === "GET") return ok({ config: stored, revision, health: "ready", source: "builtin+local" });
            const body = await request.json() as { config: AiConfig; expectedRevision: number };
            writes.push(body.config);
            if (failSave) return Response.json({ code: 500, msg: "测试：服务器暂时无法保存" }, { status: 500 });
            if (body.expectedRevision !== revision) return Response.json({ code: 409, msg: "revision conflict" }, { status: 409 });
            stored = body.config;
            return ok({ saved: true, revision: ++revision });
        }
        if (url.pathname === "/api/comfyui/userdata") return ok([
            { name: "scene-a.json" }, { name: "workflows/scene-b.json" }, { name: "nested/scene-c.json" },
            { name: "非常长的工作流名称-需要完整辨认用途与版本的工作流文件.json" }, { name: "scene-e.json" },
        ]);
        if (url.pathname === "/api/comfyui/workflow-info") {
            const body = await request.json() as { file: string; capability: string };
            reads.push(body);
            if (failParse) return Response.json({ code: 400, msg: "测试：工作流无法解析" }, { status: 400 });
            return ok({ workflowId: body.file, title: "远端默认名称", capability: body.capability,
                workflowJson: { "1": { class_type: "CLIPTextEncode", inputs: { text: "fixture" } }, ...(body.file.endsWith("scene-e.json") ? { "2": { class_type: "LoadImage", inputs: { image: "reference.png" } } } : {}) },
                sourceWorkflowJson: { nodes: [{ id: 1, type: "CLIPTextEncode", widgets_values: ["fixture"] }] },
                fields: [{ nodeId: "1", fieldName: "text", label: "提示词", enabled: true, source: "prompt" }, ...(body.file.endsWith("scene-e.json") ? [{ nodeId: "2", fieldName: "image", source: "referenceImage", enabled: true, safeToOverride: true }] : [])],
            });
        }
        if (url.pathname.startsWith("/api/")) { unexpected.push(url.pathname); return new Response("Unexpected API", { status: 500 }); }
        return new Response(`<!DOCTYPE html><html class="${url.searchParams.get("theme") === "dark" ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root" class="app-product-workspace"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const [width, theme] of [[1280, "light"], [390, "dark"], [1280, "dark"], [390, "light"]] as const) {
            stored = structuredClone({ ...defaultConfig, channels: [], comfyUI: { enabled: true, baseUrl: "https://comfy.example", apiKey: "", workflows: [], selectedWorkflowId: "" } });
            writes.length = 0; reads.length = 0; revision = 1; failSave = false; failParse = false;
            const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: "reduce" });
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://**", (route) => route.abort());
            await page.goto(`${server.url}?theme=${theme}`);
            await page.getByRole("heading", { name: "选择一个工作流" }).waitFor().catch((error) => { throw new Error(`${error.message}\nBrowser errors: ${errors.join("\n")}`); });
            await page.getByRole("button", { name: "读取目录", exact: true }).click();
            const file = (name: string) => page.getByRole("button", { name: new RegExp(name) });
            const editor = page.getByRole("region", { name: "当前工作流配置" });
            const title = page.getByLabel("显示名称", { exact: true });
            const save = page.getByRole("button", { name: "保存配置", exact: true });
            await file("scene-a.json").click();
            expect(await save.count()).toBe(1);
            expect(await save.isDisabled()).toBe(true);
            expect(await page.getByRole("radio", { checked: true }).count()).toBe(0);
            await title.fill("我的视频工作流");
            await page.getByRole("radio", { name: "视频", exact: true }).check();
            await file("scene-b.json").click();
            await title.fill("尚未提交的音频草稿");
            await page.getByRole("radio", { name: "音频", exact: true }).check();
            await file("scene-a.json").click();
            expect(await title.inputValue()).toBe("我的视频工作流");
            expect(await page.getByRole("radio", { name: "视频", exact: true }).isChecked()).toBe(true);
            expect(writes).toHaveLength(0);
            expect(reads).toHaveLength(0);
            await save.click();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows).toHaveLength(1);
            expect(stored.comfyUI.workflows[0]).toMatchObject({ workflowId: "workflows/scene-a.json", title: "我的视频工作流", capability: "video" });
            expect(stored.comfyUI.workflows[0]).toMatchObject({ sourceWorkflowJson: { nodes: [{ id: 1, type: "CLIPTextEncode", widgets_values: ["fixture"] }] } });
            expect(reads[0]).toMatchObject({ file: "workflows/scene-a.json", capability: "video" });
            await file("scene-b.json").click();
            expect(await title.inputValue()).toBe("尚未提交的音频草稿");
            failSave = true;
            await save.click();
            await editor.getByText("测试：服务器暂时无法保存", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows).toHaveLength(1);
            expect(await title.inputValue()).toBe("尚未提交的音频草稿");
            expect(await editor.getByText("已保存到服务器", { exact: true }).count()).toBe(0);
            failSave = false;
            await save.click();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows).toHaveLength(2);
            expect(reads.at(-1)).toMatchObject({ file: "workflows/scene-b.json", capability: "audio" });
            const beforeSwitch = reads.length;
            await page.getByRole("radio", { name: "图片", exact: true }).check();
            expect(reads.length).toBe(beforeSwitch);
            failParse = true;
            const writesBeforeParse = writes.length;
            await save.click();
            await editor.getByText("测试：工作流无法解析", { exact: true }).waitFor();
            expect(writes.length).toBe(writesBeforeParse);
            expect(stored.comfyUI.workflows[1].capability).toBe("audio");
            failParse = false;
            await save.click();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows[1].capability).toBe("image");
            await file("scene-e.json").click();
            await title.fill("有图分支");
            await page.getByRole("radio", { name: "图片", exact: true }).check();
            await save.click();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            await file("scene-b.json").click();
            await title.fill("统一图片模型");
            await page.getByRole("combobox", { name: "有参考图时使用" }).click();
            await page.locator(".ant-select-dropdown").getByText("有图分支", { exact: true }).click();
            await file("scene-e.json").click();
            await file("scene-b.json").click();
            expect(await editor.locator(".ant-select").innerText()).toContain("有图分支");
            failSave = true;
            await save.click();
            await editor.getByText("测试：服务器暂时无法保存", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows[1].imageEditWorkflowId).toBeUndefined();
            failSave = false;
            await save.click();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows[1].imageEditWorkflowId).toBe("workflows/scene-e.json");
            const checkUnifiedPicker = async () => {
                const picker = page.getByRole("region", { name: "图片模型验证" }).getByRole("button");
                await picker.click();
                const brand = page.getByRole("button", { name: "ComfyUI", exact: true });
                if (await brand.getAttribute("aria-expanded") !== "true") await brand.click();
                await page.getByRole("option", { name: "统一图片模型", exact: true }).waitFor();
                expect(await page.getByRole("option", { name: "有图分支", exact: true }).count()).toBe(0);
                await page.getByRole("option", { name: "统一图片模型", exact: true }).click();
            };
            await checkUnifiedPicker();
            await file("scene-e.json").click();
            await page.getByRole("button", { name: "移除配置", exact: true }).click();
            await editor.getByText("此工作流用于“统一图片模型”的有图生成，请先在该模型中解除关联", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows).toHaveLength(3);
            await page.getByRole("radio", { name: "视频", exact: true }).check();
            await save.click();
            await editor.getByText("自动切换只能关联图片工作流", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows[2].capability).toBe("image");
            await page.reload();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            await file("scene-b.json").click();
            expect(await editor.locator(".ant-select").innerText()).toContain("有图分支");
            await checkUnifiedPicker();
            await editor.locator(".ant-select-clear").click();
            await save.click();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows[1].imageEditWorkflowId).toBeUndefined();
            await file("scene-e.json").click();
            await page.getByRole("button", { name: "移除配置", exact: true }).click();
            await editor.getByText("未保存", { exact: true }).waitFor();
            await page.getByRole("button", { name: "读取目录", exact: true }).click();
            await file("scene-c.json").click();
            await page.getByRole("radio", { name: "视频", exact: true }).check();
            await save.click();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            expect(reads.at(-1)).toMatchObject({ file: "workflows/nested/scene-c.json", capability: "video" });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
            if (width < 1024) {
                await page.getByRole("button", { name: "选择其他文件", exact: true }).click();
                await file("scene-c.json").click();
                const box = (await editor.boundingBox())!;
                expect(box.y).toBeGreaterThanOrEqual(0);
                expect(box.y).toBeLessThan(960);
            }
            if (process.env.COMFYUI_SETTINGS_SCREENSHOTS) {
                await page.screenshot({ path: `${process.env.COMFYUI_SETTINGS_SCREENSHOTS}/comfyui-${theme}-${width}.png`, fullPage: true });
                await page.locator("main").evaluate((element) => element.scrollTo(0, 0));
                await page.screenshot({ path: `${process.env.COMFYUI_SETTINGS_SCREENSHOTS}/comfyui-top-${theme}-${width}.png`, fullPage: true });
            }
            await page.reload();
            await editor.getByText("已保存到服务器", { exact: true }).waitFor();
            await file("scene-a.json").click();
            expect(await title.inputValue()).toBe("我的视频工作流");
            expect(await page.getByRole("radio", { name: "视频", exact: true }).isChecked()).toBe(true);
            await page.getByRole("button", { name: "移除配置", exact: true }).click();
            await editor.getByText("未保存", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows.map((workflow) => workflow.workflowId)).toEqual(["workflows/scene-b.json", "workflows/nested/scene-c.json"]);
            await file("scene-b.json").click();
            failSave = true;
            await page.getByRole("button", { name: "移除配置", exact: true }).click();
            await editor.getByText("测试：服务器暂时无法保存", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows).toHaveLength(2);
            failSave = false;
            await page.getByRole("button", { name: "移除配置", exact: true }).click();
            await editor.getByText("未保存", { exact: true }).waitFor();
            await file("scene-c.json").click();
            await page.getByRole("button", { name: "移除配置", exact: true }).click();
            await editor.getByText("未保存", { exact: true }).waitFor();
            expect(stored.comfyUI.workflows).toHaveLength(0);
            await page.reload();
            await page.getByRole("heading", { name: "选择一个工作流" }).waitFor();
            expect(await page.getByRole("button", { name: /scene-[abc].json/ }).count()).toBe(0);
            expect(errors).toEqual([]);
            await page.close();
        }
        expect(unexpected).toEqual([]);
    } finally { await browser.close(); server.stop(true); }
}, 120000);
