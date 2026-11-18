import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import sharp from "sharp";
import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script><main><img src="pixel.svg"><p class="eyebrow">THE CROW’S LOG</p><h1 id="target">Initial crow</h1><p>Notes from the northern watch.</p><a href="second.html">Read the next entry</a></main>';
const requests = [];
let calls = 0;
const provider = createServer((request, response) => {
    if (request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "crow-0" }] })); return; }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        if (body.stream === false) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] })); return; }
        const messages = body.messages ?? [];
        const index = messages.findLastIndex((message) => message.role === "user");
        const prompt = JSON.stringify(messages[index]?.content ?? "");
        const results = messages.slice(index + 1).filter((message) => message.role === "tool").length;
        const create = [
            { path: "index.html", content: html },
            { path: "style.css", content: "body{margin:0;background:#f4ede0;color:#14283c;font:16px sans-serif}main{margin:28px;padding:30px;background:#fff;border-radius:12px;box-shadow:0 4px 20px #14283c22}h1{color:rgb(20, 40, 60)}.eyebrow{font-size:11px;letter-spacing:.2em;color:#9c592d}a{color:#9c592d}img{width:48px;height:48px}" },
            { path: "app.js", content: "const data = await fetch('./data.json').then(r => r.json()); document.body.dataset.script = data.status" },
            { path: "data.json", content: '{"status":"loaded"}' },
            { path: "second.html", content: '<!doctype html><link rel="stylesheet" href="style.css"><main><h1 id="second">Second entry</h1><p>A different local source.</p></main>' },
            { path: "pixel.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>' },
        ];
        let step;
        if (prompt.includes("CREATE PREVIEW")) step = create[results] && { name: "write", input: create[results] };
        if (prompt.includes("CHANGE PREVIEW") && results === 0) step = { name: "edit", input: { path: "index.html", edits: [{ old_string: "Initial crow", new_string: "Changed crow" }] } };
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (step) response.write(streamChunk(body.model, { role: "assistant", tool_calls: [{ index: 0, id: `call-${++calls}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } }] }, "tool_calls"));
        else response.write(streamChunk(body.model, { role: "assistant", content: "Done" }, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let page;
let failed = false;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const configPath = join(trial.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.providers["faux-0"].images = true;
    writeFileSync(configPath, JSON.stringify(config));
    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    const composer = page.locator(".composer-input");
    await composer.fill("CREATE PREVIEW");
    await composer.press("Enter");
    const session = page.locator('[data-session][data-phase="attached"]').first();
    await session.waitFor({ timeout: 45_000 });
    const sessionId = await session.getAttribute("data-session");
    const folder = join(trial.home, "runtime", "sessions", `${sessionId}.jsonl.files`);
    await until("the initial files", () => calls >= 6 && existsSync(join(folder, "index.html")) && readFileSync(join(folder, "index.html"), "utf8") === html);
    const realFolder = realpathSync(folder);
    await until("the first turn", async () => (await page.locator(".send-button").getAttribute("data-mode")) === "send");
    await page.getByRole("button", { name: "Toggle Right Pane" }).click();
    await page.locator('[data-pane-launcher]').click();
    await page.locator('[data-pane-option="core.files"]').click();
    await page.locator('.file-entry', { hasText: 'index.html' }).click();
    await page.locator('.file-preview-lines', { hasText: 'Initial crow' }).waitFor();
    await composer.fill("source draft");
    await press(app, "R", [MODIFIER]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await composer.inputValue() !== "source draft" || await page.locator('iframe[title="File preview"]').count() !== 0) throw new Error("Source shortcut changed the window.");
    await composer.fill("");
    if (process.env.VERA_PREVIEW_PROOF) await page.screenshot({ path: `${process.env.VERA_PREVIEW_PROOF}-source.png` });
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const frame = page.frameLocator('iframe[title="File preview"]');
    await frame.locator("#target").waitFor({ timeout: 15_000 });
    if (await frame.locator("body").getAttribute("data-script") !== "loaded") throw new Error("Relative script did not run");
    if (await frame.locator("#target").evaluate((element) => getComputedStyle(element).color) !== "rgb(20, 40, 60)") throw new Error("Relative CSS did not load");
    if (!await frame.locator("img").evaluate((image) => image.complete && image.naturalWidth === 8)) throw new Error("Relative image did not load");
    await page.evaluate(() => {
        const preview = document.querySelector('iframe[title="File preview"]');
        const decoy = document.createElement("iframe");
        decoy.className = "browser-frame";
        decoy.name = "browser-decoy";
        decoy.src = preview.src;
        decoy.style.cssText = "position:fixed;left:0;top:0;width:30px;height:30px";
        document.body.prepend(decoy);
    });
    const pointer = page.getByRole("button", { name: "Select element" });
    await pointer.click();
    const target = frame.locator("#target");
    await until("annotation tools", async () => await frame.locator('[data-vera-annotation]').count() === 1);
    if (await page.frameLocator('iframe[name="browser-decoy"]').locator('[data-vera-annotation]').count()) throw new Error("Annotation targeted the other frame");
    await target.click({ force: true });
    const zooms = [1, 1, 1.25, 0.8];
    let headingReference;
    const initialFrame = await page.locator('iframe[title="File preview"]').boundingBox();
    for (const [index, zoom] of zooms.entries()) {
        if (index === 1) {
            await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1840, 1000));
            await until("preview moved", async () => (await page.locator('iframe[title="File preview"]').boundingBox()).x > initialFrame.x + 200);
        }
        if (index >= 2) {
            await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value), zoom);
            await until("shell zoom", async () => Math.abs(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()) - zoom) < 0.001);
        }
        let previousLayout;
        let stableFrames = 0;
        await until("selection layout settled", async () => {
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
            const bounds = await target.boundingBox();
            const surface = await page.locator('iframe[title="File preview"]').boundingBox();
            if (bounds === null || surface === null || bounds.width <= 0 || bounds.x < surface.x || bounds.x + bounds.width > surface.x + surface.width) return false;
            const layout = JSON.stringify({ bounds, surface });
            stableFrames = layout === previousLayout ? stableFrames + 1 : 0;
            previousLayout = layout;
            return stableFrames >= 3;
        });
        if (index === 0) headingReference = await sharp(await target.screenshot()).resize(200, 100).removeAlpha().raw().toBuffer();
        await until("Add available", async () => await frame.locator('[data-vera-annotation]').evaluate((element) => {
            const button = element.shadowRoot.querySelector('button[title="Add to chat"]');
            return button && !button.disabled && button.getClientRects().length > 0;
        }));
        await frame.locator('[data-vera-annotation]').evaluate((element) => element.shadowRoot.querySelector('button[title="Add to chat"]').click());
        await until(`capture ${index + 1}`, async () => await page.locator('.page-capture-chip[data-attaching="false"]').count() === index + 1);
    }
    await page.locator('iframe[name="browser-decoy"]').evaluate((element) => element.remove());
    if (process.env.VERA_PREVIEW_PROOF) await page.screenshot({ path: `${process.env.VERA_PREVIEW_PROOF}-annotated.png` });
    await composer.fill("CHANGE PREVIEW");
    await composer.press("Enter");
    await until("provider source identity and screenshot", () => requests.some((body) => { const text = JSON.stringify(body.messages); return text.includes(`Local source file: ${join(realFolder, "index.html")}`) && text.includes("#target") && text.includes("Initial crow") && text.includes("data:image/"); }));
    const request = requests.findLast((body) => JSON.stringify(body.messages).includes(`Local source file: ${join(realFolder, "index.html")}`));
    const user = request.messages.findLast((message) => message.role === "user");
    const images = user.content.filter((part) => part.type === "image_url");
    if (images.length !== zooms.length) throw new Error(`Expected ${zooms.length} captures, got ${images.length}`);
    let reference;
    let referenceSize;
    for (const [index, image] of images.entries()) {
        const bytes = Buffer.from(image.image_url.url.split(",")[1], "base64");
        if (process.env.VERA_PREVIEW_PROOF) writeFileSync(`${process.env.VERA_PREVIEW_PROOF}-capture-${index}.png`, bytes);
        const size = await sharp(bytes).metadata();
        const pixels = await sharp(bytes).resize(200, 100).removeAlpha().raw().toBuffer();
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 3) if (pixels[i] < 80 && pixels[i + 1] < 100 && pixels[i + 2] < 120) ink += 1;
        if (ink < 500 || ink > 6500) throw new Error(`Capture ${index + 1} has unexpected heading ink: ${ink}`);
        if (reference === undefined) {
            let difference = 0;
            for (let i = 0; i < pixels.length; i += 1) difference += Math.abs(headingReference[i] - pixels[i]);
            if (difference / pixels.length > 15) throw new Error("The first capture does not match the unzoomed heading");
            reference = pixels;
            referenceSize = size;
            continue;
        }
        if (Math.abs(size.width / referenceSize.width - zooms[index]) > 0.04 || Math.abs(size.height / referenceSize.height - zooms[index]) > 0.04) throw new Error(`Capture ${index + 1} has the wrong dimensions`);
        let difference = 0;
        for (let i = 0; i < pixels.length; i += 1) difference += Math.abs(reference[i] - pixels[i]);
        if (difference / pixels.length > 15) throw new Error(`Capture ${index + 1} does not match the heading: ${difference / pixels.length}`);
    }
    await until("the edit", () => readFileSync(join(folder, "index.html"), "utf8").includes("Changed crow"));
    await composer.fill("preview reload draft");
    await press(app, "R", [MODIFIER]);
    await frame.locator("#target", { hasText: "Changed crow" }).waitFor();
    await frame.locator("body").evaluate(() => { window.reloadSentinel = true; });
    await page.locator('iframe[title="File preview"]').evaluate((element) => element.focus());
    await press(app, "R", [MODIFIER, "shift"]);
    await until("focused preview reload", async () => await frame.locator("body").evaluate(() => window.reloadSentinel !== true).catch(() => false));
    if (await composer.inputValue() !== "preview reload draft") throw new Error("Preview shortcut lost the draft.");
    await composer.fill("");
    if (process.env.VERA_PREVIEW_PROOF) await page.screenshot({ path: `${process.env.VERA_PREVIEW_PROOF}-reload.png` });
    const firstUrl = await page.locator('iframe[title="File preview"]').getAttribute("src");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await page.locator('.file-preview-lines', { hasText: 'Changed crow' }).waitFor();
    await until("released scope", async () => await app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, firstUrl) === 404);
    if (await page.locator('iframe[title="File preview"]').count()) throw new Error("Preview frame survived Source");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await frame.getByRole("link", { name: "Read the next entry" }).click();
    await frame.locator("#second").waitFor();
    await page.getByRole("button", { name: "Select element" }).click();
    await until("second annotation", async () => await frame.locator('[data-vera-annotation]').count() === 1);
    await frame.locator("#second").click({ force: true });
    await frame.locator('[data-vera-annotation]').evaluate((element) => element.shadowRoot.querySelector('button[title="Add to chat"]').click());
    await page.locator('.page-capture-chip[data-attaching="false"]').waitFor();
    await composer.fill("SECOND CAPTURE");
    await composer.press("Enter");
    await until("current source identity", () => requests.some((body) => JSON.stringify(body.messages).includes(`Local source file: ${join(realFolder, "second.html")}`)));
    const secondUrl = await page.locator('iframe[title="File preview"]').getAttribute("src");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await until("second scope released", async () => await app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, secondUrl) === 404);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await frame.locator("#target").waitFor();
    unlinkSync(join(folder, "index.html"));
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await frame.getByText("This file is unavailable in the preview.").waitFor();
    await page.getByRole("button", { name: "Source", exact: true }).click();
    console.log("local preview e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page) console.error("Page text:", await page.locator(".app").innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
