import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const prompt = "Describe this selection";
const requests = [];
const server = createServer((request, response) => {
    if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { content: "Crow" }, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><title>Annotation fixture</title><style>body{margin:0;padding:24px;font:16px sans-serif}#target{display:block;width:320px;height:120px;padding:16px;color:rgb(20, 40, 60);background:rgb(240, 240, 240)}</style></head><body><p id="target">This domain is for annotation testing.</p><script>document.querySelector('#target').scrollIntoView()</script></body></html>`);
});

const trial = startTrial();
let app;
let page;
let failed = false;

try {
    await Promise.all([
        new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
        new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve)),
    ]);
    configureFauxHome(trial.home, server.address().port);
    const configPath = join(trial.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.providers["faux-0"].images = true;
    writeFileSync(configPath, JSON.stringify(config));

    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();

    const composer = page.locator(".composer-input");
    await composer.fill("Start the annotation test session");
    await composer.press("Enter");
    await page.waitForSelector('[data-session][data-phase="attached"]', { timeout: 45_000 });
    await page.locator(".turn").last().getByText("Crow", { exact: true }).waitFor({ timeout: 30_000 });
    await until("the setup turn to finish", async () => await page.locator(".send-button").getAttribute("data-mode") === "send");

    await press(app, "K", [MODIFIER]);
    const palette = page.locator('input[aria-label="Command palette"]');
    await palette.fill("Usage");
    await palette.press("Enter");
    const pane = page.locator('[data-location="rightPane"]');
    const address = pane.getByRole("textbox", { name: "Address" });
    await address.waitFor();
    await address.fill(`http://127.0.0.1:${fixture.address().port}/`);
    await address.press("Enter");

    const browserContents = async () => app.evaluate(({ BrowserWindow }) => {
        const child = BrowserWindow.getAllWindows()[0].contentView.children.find((candidate) => candidate.webContents?.getURL().includes("127.0.0.1"));
        return child?.webContents.id;
    });
    await until("the fixture in the Browser tab", async () => (await browserContents()) !== undefined);
    let contentsId = await browserContents();
    const evaluateFixture = (expression) => app.evaluate(async ({ webContents }, args) => webContents.fromId(args.id)?.executeJavaScript(args.expression), { id: contentsId, expression });
    await until("the fixture target", async () => await evaluateFixture("document.querySelector('#target')?.innerText") === "This domain is for annotation testing.");

    const trigger = pane.getByRole("button", { name: "Select element" });
    await trigger.waitFor();
    const runningCommand = trigger.click();
    await until("the annotation toolbar", async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]')?.shadowRoot?.querySelector('[role=toolbar]'))"));
    const toolbarBounds = await evaluateFixture(`(() => {
        const shadow = document.querySelector('[data-vera-annotation]').shadowRoot;
        const toolbar = shadow.querySelector('[role="toolbar"]');
        const bounds = (element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        return {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            toolbar: bounds(toolbar),
            add: bounds(toolbar.querySelector('button[title="Add to chat"]')),
            close: bounds(toolbar.querySelector('button[title="Close"]')),
        };
    })()`);
    for (const [label, rect] of Object.entries({ toolbar: toolbarBounds.toolbar, close: toolbarBounds.close })) {
        if (rect.left < 0 || rect.right > toolbarBounds.viewportWidth || rect.top < 0 || rect.bottom > toolbarBounds.viewportHeight || rect.width <= 0 || rect.height <= 0) {
            throw new Error(`The annotation ${label} controls are outside the page viewport: ${JSON.stringify(toolbarBounds)}.`);
        }
    }

    const selected = await evaluateFixture(`(() => {
        const target = document.querySelector('#target');
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
        return target.id;
    })()`);
    if (selected !== "target") throw new Error(`The fixture selection returned ${selected}.`);
    const stable = await evaluateFixture(`(() => {
        const shadow = document.querySelector('[data-vera-annotation]').shadowRoot;
        const toolbar = shadow.querySelector('[role=toolbar]');
        toolbar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: 1, clientY: 1 }));
        const tag = shadow.querySelector('.tag').textContent;
        const target = document.querySelector('#target');
        target.style.marginTop = '25px';
        document.dispatchEvent(new Event('scroll'));
        const aligned = Math.abs(parseFloat(shadow.querySelector('.hover').style.top) - target.getBoundingClientRect().top) < 1;
        target.removeAttribute('style');
        document.dispatchEvent(new Event('scroll'));
        return tag === 'p' && aligned;
    })()`);
    if (!stable) throw new Error('Selection changed over the toolbar or did not follow scrolling.');

    await evaluateFixture(`(() => {
        const shadow = document.querySelector('[data-vera-annotation]').shadowRoot;
        const toolbar = shadow.querySelector('[role=toolbar]');
        toolbar.querySelector('button[title="Shapes"]').click();
        toolbar.querySelector('button[title="Rectangle"]').click();
        const target = document.querySelector('#target').getBoundingClientRect();
        const start = { x: target.left + 20, y: target.top + 20 };
        const end = { x: target.left + 110, y: target.top + 70 };
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: end.x, clientY: end.y }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: end.x, clientY: end.y }));
        toolbar.querySelector('button[title="Add to chat"]').click();
        return true;
    })()`);
    await runningCommand;

    const chip = page.locator(".page-capture-chip");
    await chip.waitFor({ timeout: 10_000 });
    await until("toolbar and selection restored after capture", async () => await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]')?.shadowRoot;
        return s?.querySelector('[role=toolbar]')?.style.display !== 'none' && s?.querySelector('.hover')?.style.display === 'block';
    })()`));
    await evaluateFixture(`document.querySelector('#target').textContent = 'مرحبا'.repeat(80)`);
    await evaluateFixture(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Add to chat"]').click()`);
    await until("a second capture without closing tools", async () => await page.locator('.page-capture-chip').count() === 2);
    const rtlChip = page.locator('.page-capture-chip').last();
    await rtlChip.focus();
    const rtl = rtlChip.locator('.context-pop p').filter({ hasText: 'مرحبا' });
    await rtl.waitFor();
    const readable = await rtl.evaluate((element) => ({ direction: getComputedStyle(element.querySelector('span')).direction, fits: element.scrollWidth <= element.clientWidth + 1 }));
    if (readable.direction !== 'rtl' || !readable.fits) throw new Error(`RTL capture preview is not readable: ${JSON.stringify(readable)}`);
    await rtlChip.locator('.chip-x').click();
    await evaluateFixture(`document.querySelector('#target').textContent = 'This domain is for annotation testing.'`);
    await app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        const original = contents.capturePage;
        contents.capturePage = function (...args) {
            contents.capturePage = original;
            throw new Error('capture failed');
        };
    }, contentsId);
    await evaluateFixture(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Add to chat"]').click()`);
    await until("toolbar restored after a failed capture", async () => await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]')?.shadowRoot;
        return s?.querySelector('[role=toolbar]')?.style.display === 'flex' && s?.querySelector('.hover')?.style.display === 'block';
    })()`));
    if (await page.locator('.page-capture-chip').count() !== 1) throw new Error('A failed capture attached an image.');
    await evaluateFixture(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Add to chat"]').click()`);
    await until("capture succeeds after a failure", async () => await page.locator('.page-capture-chip').count() === 2);
    await page.locator('.page-capture-chip').last().locator('.chip-x').click();
    const chipText = await chip.innerText();
    if (!chipText.includes("<p /> This domain is for")) throw new Error(`The annotation chip shows ${chipText}.`);
    await until("the capture to finish attaching", async () => await chip.getAttribute("data-attaching") === "false");
    await chip.hover();
    const card = chip.locator(".context-pop");
    await card.getByText("Included with your message").waitFor();
    const chipBox = await chip.boundingBox();
    const cardBox = await card.boundingBox();
    if (chipBox === null || cardBox === null) throw new Error('Preview has no bounds.');
    await page.mouse.move(Math.max(cardBox.x + 4, Math.min(chipBox.x + chipBox.width / 2, cardBox.x + cardBox.width - 4)), cardBox.y + cardBox.height - 3, { steps: 12 });
    if (!(await card.isVisible())) throw new Error('Preview closed while moving the pointer into it.');
    await chip.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    if (!(await card.getByRole('button', { name: 'Show more details' }).evaluate((element) => element === document.activeElement))) throw new Error('Tab did not reach preview details.');
    await page.keyboard.press('Enter');
    await card.getByText('Computed styles', { exact: true }).waitFor();
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
        window.__previewEscapeLeaked = false;
        window.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.__previewEscapeLeaked = true; }, { once: true });
    });
    await page.keyboard.press('Escape');
    if (await card.isVisible()) throw new Error('Escape did not close the capture preview.');
    if (await page.evaluate(() => window.__previewEscapeLeaked)) throw new Error('Preview Escape escaped to the session.');
    await chip.locator('.chip-x').focus();
    const cardImage = card.locator("img");
    await cardImage.waitFor();
    const cardImageSize = await cardImage.evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
    if (cardImageSize.width < 300 || cardImageSize.height < 100) throw new Error(`The capture card image is ${cardImageSize.width}x${cardImageSize.height}.`);
    const sampledPixels = await cardImage.evaluate(async (image) => {
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("The capture image cannot be sampled.");
        context.drawImage(image, 0, 0);
        const scale = image.naturalWidth / 352;
        return {
            background: Array.from(context.getImageData(5, 5, 1, 1).data),
            rectangle: Array.from(context.getImageData(Math.round(20 * scale), Math.round(45 * scale), 1, 1).data),
        };
    });
    if (sampledPixels.background.join(",") !== "240,240,240,255") throw new Error(`The selected image background pixel is ${sampledPixels.background.join(",")}.`);
    if (sampledPixels.rectangle.join(",") !== "232,88,42,255") throw new Error(`The rectangle stroke pixel is ${sampledPixels.rectangle.join(",")}.`);
    if (!(await card.innerText()).includes("Element\n<p /> #target")) throw new Error(`The capture card lacks element details: ${await card.innerText()}`);
    if (!(await card.innerText()).includes("This domain is for annotation testing.")) throw new Error("The capture card lacks the selected text.");
    await card.getByRole("button", { name: "Show more details" }).click();
    for (const label of ["Computed styles", "HTML", "Siblings"]) await card.getByText(label, { exact: true }).waitFor();
    if (process.env.VERA_ANNOTATION_PROOF) await page.screenshot({ path: process.env.VERA_ANNOTATION_PROOF });

    await composer.fill(prompt);
    await composer.press("Enter");
    await until("the provider request with the annotation image", async () => requests.some((body) => JSON.stringify(body.messages ?? []).includes("Selected in the Browser tab on")));
    await until("the sent text block in the transcript", async () => {
        const userTurn = page.locator(".user-turn, .user-bubble").last();
        if (await userTurn.count() === 0) return false;
        const text = await userTurn.innerText();
        return text.includes(prompt) && text.includes("Selected in the Browser tab on") && text.includes("Siblings:");
    }, 15_000);
    const sent = requests.findLast((body) => JSON.stringify(body.messages ?? []).includes("Selected in the Browser tab on"));
    const user = sent?.messages?.findLast((message) => message.role === "user");
    const parts = Array.isArray(user?.content) ? user.content : [];
    const content = typeof user?.content === "string"
        ? user.content
        : parts.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
    for (const expected of [prompt, "Selected in the Browser tab on", "Element: p", "Selector: #target", "Text: This domain is for annotation testing.", "HTML: <p id=\"target\""]) {
        if (!content.includes(expected)) throw new Error(`The sent provider message lacks ${JSON.stringify(expected)}: ${content}`);
    }
    const images = parts.filter((part) => part?.type === "image_url" && typeof part.image_url?.url === "string");
    if (images.length !== 1) throw new Error(`The provider received ${images.length} image attachments.`);
    if (!images[0].image_url.url.startsWith("data:image/png;base64,")) throw new Error("The provider image attachment is not the captured PNG.");
    await evaluateFixture("document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title=\"Close\"]').click()");
    await until("first annotation command closed", async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));
    await trigger.waitFor({ state: 'visible' });
    await until('annotation trigger becomes available', async () => await trigger.isEnabled());
    await trigger.click();
    await until("annotation mode on the second run", async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]')?.shadowRoot)"));
    await evaluateFixture("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("annotation mode closed by Escape", async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));

    await trigger.click();
    await until("annotation mode for close", async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]')?.shadowRoot)"));
    await evaluateFixture("document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title=\"Close\"]').click()");
    await until("annotation mode closed by toolbar", async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));

    await address.fill("usage");
    await address.press("Enter");
    const annexFrame = pane.locator('iframe.browser-frame[title="Usage"]');
    await annexFrame.waitFor({ timeout: 15_000 });
    const annexPage = page.frameLocator('iframe.browser-frame[title="Usage"]');
    await annexPage.locator(".page .toolbar .seg").first().waitFor({ timeout: 30_000 });
    const annexTarget = annexPage.locator(".page .toolbar .seg button").first();
    await annexTarget.waitFor({ timeout: 10_000 });
    const targetBox = await annexTarget.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const captureCount = await page.locator(".page-capture-chip").count();
    const annexCommand = trigger.click();
    await annexPage.locator("[data-vera-annotation]").waitFor({ timeout: 15_000 });
    await annexTarget.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    });
    await annexTarget.evaluate((element) => {
        const shadow = document.querySelector("[data-vera-annotation]").shadowRoot;
        const toolbar = shadow.querySelector('[role="toolbar"]');
        toolbar.querySelector('button[title="Shapes"]').click();
        toolbar.querySelector('button[title="Rectangle"]').click();
        const rect = element.getBoundingClientRect();
        const start = { x: rect.left + 8, y: rect.top + 8 };
        const end = { x: rect.left + 36, y: rect.top + 24 };
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }));
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: end.x, clientY: end.y }));
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: end.x, clientY: end.y }));
        toolbar.querySelector('button[title="Add to chat"]').click();
    });
    await annexCommand;
    const annexChip = page.locator(".page-capture-chip").last();
    await annexChip.waitFor({ timeout: 10_000 });
    await until("annex screenshot chip to finish attaching", async () => await annexChip.getAttribute("data-attaching") === "false");
    await annexChip.locator(".chip-x").focus();
    const annexCard = annexChip.locator(".context-pop");
    await annexCard.locator("img").waitFor({ timeout: 10_000 });
    const annexImageSize = await annexCard.locator("img").evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
    const widthScale = annexImageSize.width / targetBox.width;
    const heightScale = annexImageSize.height / targetBox.height;
    if (annexImageSize.width < 1 || annexImageSize.height < 1 || widthScale < 0.8 || widthScale > 2.2 || heightScale < 0.8 || heightScale > 2.2) {
        throw new Error(`Annex screenshot dimensions ${annexImageSize.width}x${annexImageSize.height} do not match the selected ${targetBox.width}x${targetBox.height} element.`);
    }
    await annexChip.locator(".chip-x").click();
    await annexChip.waitFor({ state: "detached", timeout: 5_000 });
    await address.fill(`http://127.0.0.1:${fixture.address().port}/`);
    await address.press('Enter');
    await annexFrame.waitFor({ state: 'detached', timeout: 10_000 });
    await until('annex frame command released on replacement', async () => await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].webContents.debugger.isAttached()));
    await until('annotation trigger available after frame replacement', async () => await trigger.isEnabled());
    await until('replacement native page ready', async () => (await browserContents()) !== undefined);
    contentsId = await browserContents();
    await trigger.click();
    await until('annotation on replacement page', async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))"));
    await app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        const original = contents.capturePage;
        contents.capturePage = function (...args) {
            contents.capturePage = original;
            return new Promise((resolve, reject) => { globalThis.releaseCapture = () => original.apply(contents, args).then(resolve, reject); });
        };
    }, contentsId);
    await evaluateFixture(`(() => {
        const rect = document.querySelector('#target').getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 20 }));
        document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Add to chat"]').click();
    })()`);
    await until('capture in flight', async () => await app.evaluate(() => typeof globalThis.releaseCapture === 'function'));
    await evaluateFixture("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until('Escape closes tools during capture', async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));
    await app.evaluate(() => { globalThis.releaseCapture(); delete globalThis.releaseCapture; });
    await until('canceled capture releases command', async () => await trigger.isEnabled());
    if (await page.locator('.page-capture-chip').count() !== 0) throw new Error('A canceled capture was attached.');
    await trigger.click();
    await until('annotation active before tab close', async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))"));
    await page.locator('[data-switcher="rightPane"] .switcher-pill:has([data-container="core.browser"])').last().locator('.switcher-close').click();
    await until('native page closed with annotation active', async () => await app.evaluate(({ webContents }, id) => !webContents.getAllWebContents().some((contents) => contents.id === id), contentsId));

    console.log("annotate e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Browser pane:", await page.locator('[data-location="rightPane"]').innerText().catch(() => "unreadable"));
    console.error("Provider requests:", requests.map((body) => (body.messages ?? []).filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : "multimodal content")));
} finally {
    const startedPids = [app?.process().pid, trial.hostPid()].filter((pid) => typeof pid === "number");
    await trial.cleanup();
    for (const pid of startedPids) {
        try {
            process.kill(pid, 0);
            throw new Error(`Trial process ${pid} is still running after cleanup.`);
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    }
    if (failed) console.error("Trial cleanup verified:", { root: trial.trialRoot, pids: startedPids });
    fixture.closeAllConnections();
    server.closeAllConnections();
    await Promise.all([
        new Promise((resolve) => fixture.close(resolve)),
        new Promise((resolve) => server.close(resolve)),
    ]);
}
process.exit(failed ? 1 : 0);
