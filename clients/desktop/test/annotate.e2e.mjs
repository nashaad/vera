import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

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
    await waitForAnnexPages(page, app);

    const composer = page.locator(".composer-input");
    await composer.fill("Start the annotation test session");
    await composer.press("Enter");
    await page.waitForSelector('[data-session][data-phase="attached"]', { timeout: 45_000 });
    await page.locator(".turn").last().getByText("Crow", { exact: true }).waitFor({ timeout: 30_000 });
    await until("the setup turn to finish", async () => await page.locator(".send-button").getAttribute("data-mode") === "send");

    await press(app, "K", [MODIFIER]);
    const palette = page.locator('input[aria-label="Command palette"]');
    await palette.fill("Open a web page");
    await page.locator('[data-command="page.openBrowser"]').click();
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

    const editProof = await evaluateFixture(`(() => {
        const shadow = document.querySelector('[data-vera-annotation]').shadowRoot;
        const button = (name) => shadow.querySelector('button[title="' + name + '"]');
        const input = shadow.querySelector('.text-entry');
        const canvas = shadow.querySelector('canvas');
        const image = () => canvas.toDataURL();
        const mouse = (type, x, y) => document.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        const click = (x, y) => { mouse('mousedown', x, y); mouse('mouseup', x, y); };
        const drag = (x, y, xx, yy) => { mouse('mousedown', x, y); mouse('mousemove', xx, yy); mouse('mouseup', xx, yy); };
        const type = (value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
        button('Text').click(); click(60, 100); type('dag'); click(200, 140);
        const outside = image();
        const consumed = input.hidden;
        button('Undo').click(); const empty = image(); button('Redo').click();
        const outsideOnce = image() === outside && empty !== outside;
        click(60, 150); type('crow'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const entered = image(); button('Undo').click(); const enterOnce = image() === outside; button('Redo').click();
        click(60, 200); type('ship'); button('Pen').click();
        const switched = image(); button('Undo').click(); const switchOnce = image() === entered; button('Redo').click();
        button('Text').click(); click(60, 250); type('sail'); input.blur();
        const blurred = image(); button('Undo').click(); const blurOnce = image() === switched; button('Redo').click();
        button('Move').click(); const pressed = button('Move').getAttribute('aria-pressed') === 'true' && document.documentElement.style.cursor === 'default';
        mouse('mousedown', 65, 95); mouse('mousemove', 95, 115); window.dispatchEvent(new Event('blur')); mouse('mouseup', 95, 115);
        const canceled = image() === blurred;
        drag(65, 95, 95, 115); const moved = image();
        button('Undo').click(); const undo = image() === blurred; button('Redo').click(); const redo = image() === moved;
        click(400, 300); const noOp = image() === moved; button('Undo').click(); const noOpHistory = image() === blurred; button('Redo').click();
        button('Clear').click();
        button('Shapes').click(); button('Arrow').click();
        const color = shadow.querySelector('input[type=color]');
        color.value = '#ff0000'; color.dispatchEvent(new Event('input')); drag(40, 50, 140, 50);
        color.value = '#0000ff'; color.dispatchEvent(new Event('input')); drag(40, 50, 140, 50);
        button('Move').click(); drag(80, 50, 80, 80);
        const ctx = canvas.getContext('2d');
        const pixel = (x, y) => Array.from(ctx.getImageData(Math.round(x * canvas.width / innerWidth), Math.round(y * canvas.height / innerHeight), 1, 1).data);
        const oldPixel = pixel(80, 50), newPixel = pixel(80, 80);
        const topmost = oldPixel[0] > 200 && oldPixel[2] < 30 && newPixel[2] > 200 && newPixel[0] < 30;
        button('Clear').click(); color.value = '#e8582a'; color.dispatchEvent(new Event('input')); button('Select element').click();
        return { consumed, outsideOnce, enterOnce, switchOnce, blurOnce, pressed, canceled, moved: moved !== blurred, undo, redo, noOp, noOpHistory, topmost };
    })()`);
    if (Object.values(editProof).some((value) => !value)) throw new Error('Annotation editing proof failed: ' + JSON.stringify(editProof));

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
        toolbar.querySelector('button[title="Move"]').click();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y + 20 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: start.x + 30, clientY: start.y + 20 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: start.x + 30, clientY: start.y + 20 }));
        toolbar.querySelector('button[title="Text"]').click();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: target.left + 65, clientY: target.top + 95 }));
        const input = shadow.querySelector('.text-entry'); input.value = 'dag'; input.dispatchEvent(new Event('input', { bubbles: true }));
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: target.left + 200, clientY: target.top + 110 }));
        toolbar.querySelector('button[title="Move"]').click();
        return true;
    })()`);
    if (process.env.VERA_ANNOTATION_EDIT_PROOF) {
        const png = await app.evaluate(async ({ webContents }, id) => Array.from((await webContents.fromId(id).capturePage()).toPNG()), contentsId);
        writeFileSync(process.env.VERA_ANNOTATION_EDIT_PROOF, Buffer.from(png));
    }
    await evaluateFixture(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Add to chat"]').click()`);
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
    await evaluateFixture(`(() => {
        const target = document.querySelector('#target');
        target.textContent = 'Une longue phrase française avec des détails lisibles. '.repeat(12);
        target.setAttribute('data-long', 'attribut '.repeat(100));
        for (let index = 0; index < 12; index++) {
            const sibling = document.createElement('p');
            sibling.textContent = 'Élément voisin avec du contenu '.repeat(10);
            sibling.className = 'proof-sibling';
            target.after(sibling);
        }
    })()`);
    await evaluateFixture(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Add to chat"]').click()`);
    await until('long capture attached', async () => await page.locator('.page-capture-chip').count() === 2);
    const longChip = page.locator('.page-capture-chip').last();
    await until('long capture ready', async () => await longChip.getAttribute('data-attaching') === 'false');
    await longChip.focus();
    const longCard = longChip.locator('.page-capture-pop');
    await longCard.getByRole('button', { name: 'Show more details' }).click();
    const expected = await evaluateFixture(`(() => {
        const target = document.querySelector('#target');
        const tag = '<p id="target" data-long="' + target.getAttribute('data-long').slice(0, 128) + '"> (selected)';
        return { html: target.outerHTML, siblings: [tag, ...Array(9).fill('<p class="proof-sibling">')].join(', ') };
    })()`);
    const htmlMore = longCard.getByRole('button', { name: 'Show more', exact: true }).first();
    await htmlMore.focus();
    await htmlMore.press('Enter');
    const siblingsMore = longCard.getByRole('button', { name: 'Show more', exact: true }).last();
    await siblingsMore.scrollIntoViewIfNeeded();
    await siblingsMore.click();
    const blocks = longCard.locator('pre');
    if (await longCard.getByRole('button', { name: 'Show less' }).count() !== 2 || await blocks.count() !== 3 || await blocks.nth(1).textContent() !== expected.html || await blocks.nth(2).textContent() !== expected.siblings) throw new Error('Expanded text differs from the captured details.');
    const originalSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    for (const size of [[800, 650], [1440, 900]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), size);
        await page.evaluate(() => {
            const app = document.querySelector('.app');
            for (const token of ['--vera-font-size-body', '--vera-font-size-label', '--vera-font-size-code']) app.style.setProperty(token, '20px');
        });
        if (size[0] === 1440) {
            await until('native Browser visible after resize', async () => await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.id === id)?.getVisible() === true, contentsId));
        }
        const proof = await longCard.evaluate((card) => {
            const rect = card.getBoundingClientRect();
            const button = card.querySelector('.page-capture-details');
            const icon = button.querySelector('svg').getBoundingClientRect();
            const label = button.querySelector('span').getBoundingClientRect();
            return {
                viewport: [innerWidth, innerHeight],
                rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width },
                alignment: Math.abs((icon.top + icon.bottom) / 2 - (label.top + label.bottom) / 2),
                codeSize: parseFloat(getComputedStyle(card.querySelector('pre')).fontSize),
                blocks: [...card.querySelectorAll('pre')].map((pre) => ({ height: pre.clientHeight, scrollHeight: pre.scrollHeight, width: pre.clientWidth, scrollWidth: pre.scrollWidth, lineHeight: parseFloat(getComputedStyle(pre).lineHeight) || parseFloat(getComputedStyle(pre).fontSize) })),
            };
        });
        if (size[0] === 1440) {
            const surface = await pane.locator('.browser-frame').boundingBox();
            const nativeVisible = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.id === id)?.getVisible(), contentsId);
            console.log('native surface proof:', JSON.stringify({ surface, card: proof.rect, nativeVisible }));
            if (surface === null || proof.rect.right > surface.x || nativeVisible !== true) throw new Error('Expanded capture unnecessarily covers the native Browser.');
        }
        console.log('capture layout proof:', JSON.stringify(proof));
        if (proof.rect.left < 0 || proof.rect.top < 0 || proof.rect.right > proof.viewport[0] || proof.rect.bottom > proof.viewport[1]) throw new Error('Expanded capture is outside the viewport.');
        if (proof.codeSize !== 20 || proof.alignment > 1 || proof.blocks.length !== 3 || proof.blocks.some((block) => block.scrollWidth > block.width + 1 || block.scrollHeight > block.height + 1 || block.height < block.lineHeight * 2)) throw new Error('Capture details are clipped or the chevron is misaligned.');
    }
    const less = longCard.getByRole('button', { name: 'Show less' });
    await less.last().scrollIntoViewIfNeeded();
    await less.last().click();
    await less.first().scrollIntoViewIfNeeded();
    await less.first().focus();
    await less.first().press('Enter');
    if (await longCard.getByRole('button', { name: 'Show more', exact: true }).count() !== 2) throw new Error('Expanded details cannot be collapsed.');
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), originalSize);
    await page.evaluate(() => {
        const app = document.querySelector('.app');
        for (const token of ['--vera-font-size-body', '--vera-font-size-label', '--vera-font-size-code']) app.style.removeProperty(token);
    });
    await longChip.locator('.chip-x').click();
    await evaluateFixture(`(() => {
        const target = document.querySelector('#target');
        target.textContent = 'This domain is for annotation testing.';
        target.removeAttribute('data-long');
        document.querySelectorAll('.proof-sibling').forEach((sibling) => sibling.remove());
    })()`);
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
        const text = context.getImageData(Math.round(65 * scale), Math.round(78 * scale), Math.round(40 * scale), Math.round(18 * scale)).data;
        let textPixels = 0;
        for (let i = 0; i < text.length; i += 4) {
            if (text[i] > 200 && text[i + 1] < 170 && text[i + 2] < 130) textPixels++;
        }
        return {
            background: Array.from(context.getImageData(5, 5, 1, 1).data),
            rectangle: Array.from(context.getImageData(Math.round(50 * scale), Math.round(45 * scale), 1, 1).data),
            textPixels,
        };
    });
    if (sampledPixels.background.join(",") !== "240,240,240,255") throw new Error(`The selected image background pixel is ${sampledPixels.background.join(",")}.`);
    if (sampledPixels.rectangle.some((value, index) => Math.abs(value - [232, 88, 42, 255][index]) > 6)) throw new Error(`The rectangle stroke pixel is ${sampledPixels.rectangle.join(",")}.`);
    if (sampledPixels.textPixels < 3) throw new Error('Captured text is missing from its original position.');
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
    const draftBeforeClose = await evaluateFixture(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('canvas').toDataURL()`);
    await evaluateFixture("document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title=\"Close\"]').click()");
    await until("first annotation command closed", async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));
    await trigger.waitFor({ state: 'visible' });
    await until('annotation trigger becomes available', async () => await trigger.isEnabled());
    await trigger.click();
    await until("annotation mode on the second run", async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]')?.shadowRoot)"));
    const restored = await evaluateFixture(`(() => {
        const hosts = document.querySelectorAll('[data-vera-annotation]');
        const s = hosts[0].shadowRoot;
        const canvas = s.querySelector('canvas');
        const image = canvas.toDataURL();
        s.querySelector('button[title="Undo"]').click(); const undone = canvas.toDataURL();
        s.querySelector('button[title="Redo"]').click();
        return { hosts: hosts.length, image, history: undone !== image && canvas.toDataURL() === image,
            selection: s.querySelector('.tag').textContent === 'p' && s.querySelector('.hover').style.display === 'block' };
    })()`);
    if (restored.hosts !== 1 || restored.image !== draftBeforeClose || !restored.history || !restored.selection) throw new Error('Close/reopen lost or duplicated the annotation draft.');
    const movedRestored = await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        const canvas = s.querySelector('canvas'); const before = canvas.toDataURL();
        const r = document.querySelector('#target').getBoundingClientRect();
        s.querySelector('button[title="Move"]').click();
        for (const [type, x, y] of [['mousedown', r.left + 68, r.top + 90], ['mousemove', r.left + 78, r.top + 100], ['mouseup', r.left + 78, r.top + 100]]) {
            document.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        }
        const changed = canvas.toDataURL() !== before; s.querySelector('button[title="Undo"]').click();
        return changed && canvas.toDataURL() === before;
    })()`);
    if (!movedRestored) throw new Error('Restored marks could not be moved and undone.');
    const reopen = async (label) => {
        await until(label + ' command ready', async () => await trigger.isEnabled());
        await trigger.click();
        await until(label + ' tools ready', async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))"));
    };
    const closeTools = async (label) => {
        await evaluateFixture("document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title=\"Close\"]').click()");
        await until(label + ' tools closed', async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));
    };
    await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        s.querySelector('button[title="Text"]').click();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 80, clientY: 100 }));
        const input = s.querySelector('.text-entry'); input.value = 'kept crow'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await closeTools('pending text');
    await reopen('pending text');
    const pendingClose = await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        const image = () => s.querySelector('canvas').toDataURL();
        const kept = image(); s.querySelector('button[title="Undo"]').click(); const undone = image();
        s.querySelector('button[title="Redo"]').click(); return { kept, undone, once: image() === kept };
    })()`);
    if (pendingClose.kept === draftBeforeClose || pendingClose.undone !== draftBeforeClose || !pendingClose.once) throw new Error('Pending text was not kept once across Close.');
    if (process.env.VERA_ANNOTATION_DRAFT_PROOF) {
        const png = await app.evaluate(async ({ webContents }, id) => Array.from((await webContents.fromId(id).capturePage()).toPNG()), contentsId);
        writeFileSync(process.env.VERA_ANNOTATION_DRAFT_PROOF, Buffer.from(png));
    }
    const cleared = await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        s.querySelector('button[title="Clear"]').click(); return s.querySelector('canvas').toDataURL();
    })()`);
    await closeTools('cleared draft'); await reopen('cleared draft');
    if (await evaluateFixture("document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('canvas').toDataURL()") !== cleared) throw new Error('Cleared marks returned after reopen.');
    await closeTools('hidden selection');
    await evaluateFixture("document.querySelector('#target').style.display = 'none'");
    await reopen('hidden selection');
    if (!(await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        return s.querySelector('.tag').style.display !== 'block' && s.querySelector('button[title="Add to chat"]').hidden;
    })()`))) throw new Error('A hidden saved element was restored.');
    await closeTools('before reload');
    await app.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        await new Promise((resolve) => { contents.once('did-finish-load', resolve); contents.reload(); });
    }, contentsId);
    await reopen('after reload');
    if (!(await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        const canvas = s.querySelector('canvas');
        const blank = document.createElement('canvas'); blank.width = canvas.width; blank.height = canvas.height;
        s.querySelector('button[title="Undo"]').click();
        return canvas.toDataURL() === blank.toDataURL() && s.querySelector('button[title="Add to chat"]').hidden;
    })()`))) throw new Error('Reload restored a previous document draft.');

    const pendingAdd = await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        s.querySelector('button[title="Text"]').click();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 80, clientY: 100 }));
        const input = s.querySelector('.text-entry');
        input.value = 'pending crow'; input.dispatchEvent(new Event('input', { bubbles: true }));
        const add = s.querySelector('button[title="Add to chat"]');
        const available = !add.hidden && !add.disabled;
        add.click();
        return available;
    })()`);
    if (!pendingAdd) throw new Error('Pending text did not enable Add to chat.');
    await until('pending text capture attached', async () => await page.locator('.page-capture-chip').count() === 1);
    await until('pending text capture restored tools', async () => await evaluateFixture(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('[role=toolbar]').style.display === 'flex'`));
    const pendingOnce = await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        const image = () => s.querySelector('canvas').toDataURL();
        const before = image(); s.querySelector('button[title="Undo"]').click(); const after = image();
        s.querySelector('button[title="Undo"]').click(); return before !== after && image() === after;
    })()`);
    if (!pendingOnce) throw new Error('Pending text was not committed exactly once.');
    await page.locator('.page-capture-chip').last().locator('.chip-x').click();
    await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        s.querySelector('button[title="Text"]').click();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 100, clientY: 120 }));
        const input = s.querySelector('.text-entry'); input.value = 'escaped crow'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluateFixture("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("annotation mode closed by Escape", async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));

    await trigger.click();
    await until("annotation mode for close", async () => await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]')?.shadowRoot)"));
    const escaped = await evaluateFixture(`(() => {
        const s = document.querySelector('[data-vera-annotation]').shadowRoot;
        const canvas = s.querySelector('canvas'); const kept = canvas.toDataURL();
        const blank = document.createElement('canvas'); blank.width = canvas.width; blank.height = canvas.height;
        s.querySelector('button[title="Undo"]').click(); const undone = canvas.toDataURL();
        s.querySelector('button[title="Redo"]').click();
        return kept !== undone && undone === blank.toDataURL() && canvas.toDataURL() === kept;
    })()`);
    if (!escaped) throw new Error('Escape did not retain pending text and history.');
    await evaluateFixture("document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title=\"Close\"]').click()");
    await until("annotation mode closed by toolbar", async () => !(await evaluateFixture("Boolean(document.querySelector('[data-vera-annotation]'))")));

    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').fill("Usage");
    await page.locator(".palette-row", { hasText: "Usage" }).first().click();
    await pane.locator("iframe").waitFor({ timeout: 15_000 });
    if (await pane.getByRole("button", { name: "Select element" }).count() !== 0) throw new Error("The Usage page exposes Browser annotation controls.");
    if (await pane.getByRole("textbox", { name: "Address" }).count() !== 0) throw new Error("Usage opened in the Browser instead of as an app page.");
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').fill("Open a web page");
    await page.locator('[data-command="page.openBrowser"]').click();
    await address.waitFor();
    await address.fill(`http://127.0.0.1:${fixture.address().port}/`);
    await address.press('Enter');
    await until("Browser address loaded after Usage", async () => (await browserContents()) !== undefined);
    await until('Browser command released after page routing', async () => await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].webContents.debugger.isAttached()));
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
