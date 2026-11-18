import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

const requests = [];
const provider = createServer((request, response) => {
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
        } else {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(streamChunk(body.model, { content: "Crow" }, "stop"));
            response.end("data: [DONE]\n\n");
        }
    });
});
const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>Draft capture</title><style>body{font:16px sans-serif;padding:24px}#target{width:300px;padding:20px;background:#eee}</style><p id="target">A crow on the deck</p>');
});
const trial = startTrial();
let page;
let failed = false;
try {
    await Promise.all([new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve)), new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))]);
    configureFauxHome(trial.home, provider.address().port);
    const configPath = join(trial.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.providers["faux-0"].images = true;
    writeFileSync(configPath, JSON.stringify(config));
    const imagePath = join(trial.trialRoot, "other.png");
    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await waitForAnnexPages(page, app);
    await page.screenshot({ path: imagePath });
    const layout = await page.evaluate(() => {
        const main = document.querySelector('main.main');
        const scroll = main.querySelector('.page-scroll');
        return { main: main.clientHeight, scroll: scroll.clientHeight };
    });
    if (Math.abs(layout.main - layout.scroll) > 1) throw new Error(`Home height changed: ${JSON.stringify(layout)}`);
    const composer = page.locator('.composer-input');
    await composer.fill('Look at this crow');
    await composer.evaluate((element, path) => {
        const data = new DataTransfer();
        data.setData('text/plain', path);
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, imagePath);
    await page.getByRole('button', { name: 'Remove Image 1' }).waitFor();
    await press(app, 'K', [MODIFIER]);
    await page.getByRole('textbox', { name: 'Command palette' }).fill('Open a web page');
    await page.locator('[data-command="page.openBrowser"]').click();
    const pane = page.locator('[data-location="rightPane"]');
    const address = pane.getByRole('textbox', { name: 'Address' });
    await address.fill(`http://127.0.0.1:${fixture.address().port}/`);
    await address.press('Enter');
    const contents = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes('127.0.0.1'))?.webContents.id);
    await until('fixture', async () => await contents() !== undefined);
    const id = await contents();
    const evaluate = (expression) => app.evaluate(({ webContents }, args) => webContents.fromId(args.id)?.executeJavaScript(args.expression), { id, expression });
    await until('target', async () => await evaluate("document.querySelector('#target')?.innerText") === 'A crow on the deck');
    const pointer = pane.getByRole('button', { name: 'Select element' });
    if (!await pointer.isEnabled()) throw new Error('Pointer disabled with no session');
    await pointer.click();
    await until('toolbar', async () => await evaluate("Boolean(document.querySelector('[data-vera-annotation]')?.shadowRoot?.querySelector('[role=toolbar]'))"));
    await evaluate(`(() => { const r = document.querySelector('#target').getBoundingClientRect(); const x = r.left + 30, y = r.top + 30; for (const type of ['mousemove','mousedown','mouseup']) document.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, clientX:x, clientY:y })); })()`);
    const add = () => evaluate(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Add to chat"]').click()`);
    await add();
    await until('first draft capture', async () => await page.locator('.page-capture-chip').count() === 1);
    await add();
    await until('second draft capture', async () => await page.locator('.page-capture-chip').count() === 2);
    await page.locator('.page-capture-chip').last().locator('.chip-x').click();
    const chip = page.locator('.page-capture-chip').first();
    await chip.focus();
    await chip.getByRole('button', { name: 'Show more details' }).click();
    if (!await chip.innerText().then((text) => text.includes('A crow on the deck'))) throw new Error('Selection details are missing');
    if (await composer.inputValue() !== 'Look at this crow' || await page.getByRole('button', { name: 'Remove Image 1' }).count() !== 1) throw new Error('Draft text or image lost');
    if (await page.locator('.app').getAttribute('data-sessions') !== '0' || requests.length !== 0) throw new Error('Session or provider call before Send');
    if (process.env.VERA_PRECHAT_PROOF) {
        await page.screenshot({ path: `${process.env.VERA_PRECHAT_PROOF}-draft.png` });
        const native = await app.evaluate(async ({ BrowserWindow }) => {
            const child = BrowserWindow.getAllWindows()[0].contentView.children.find((item) => item.webContents?.getURL().includes('127.0.0.1'));
            return { bounds: child.getBounds(), png: (await child.webContents.capturePage()).toPNG().toString('base64') };
        });
        writeFileSync(`${process.env.VERA_PRECHAT_PROOF}-native.png`, Buffer.from(native.png, 'base64'));
        writeFileSync(`${process.env.VERA_PRECHAT_PROOF}-native-bounds.json`, JSON.stringify(native.bounds));
    }
    await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('vera:session-create');
        ipcMain.removeHandler('vera:session-create');
        ipcMain.handle('vera:session-create', async (...args) => {
            globalThis.prechatCreateWaiting = true;
            await new Promise((resolve) => { globalThis.prechatCreateRelease = resolve; });
            ipcMain.removeHandler('vera:session-create');
            ipcMain.handle('vera:session-create', original);
            return original(...args);
        });
    });
    await composer.press('Enter');
    await until('create waiting', () => app.evaluate(() => globalThis.prechatCreateWaiting === true));
    await evaluate(`(() => { document.querySelector('#target').textContent = 'A late crow'; const r = document.querySelector('#target').getBoundingClientRect(); const x = r.left + 30, y = r.top + 30; for (const type of ['mousemove','mousedown','mouseup']) document.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, clientX:x, clientY:y })); })()`);
    await add();
    if (await page.locator('.page-capture-chip').count() !== 1) throw new Error('Late capture entered the first snapshot');
    await app.evaluate(() => globalThis.prechatCreateRelease());
    const session = page.locator('[data-session][data-phase="attached"]').first();
    await session.waitFor({ timeout: 45_000 });
    const firstId = await session.getAttribute('data-session');
    await until('first payload', () => requests.some((body) => JSON.stringify(body.messages).includes('A crow on the deck')));
    const first = requests.find((body) => JSON.stringify(body.messages).includes('A crow on the deck'));
    const user = first.messages.findLast((message) => message.role === 'user');
    const images = user.content.filter((part) => part.type === 'image_url');
    if (images.length !== 2 || JSON.stringify(user.content).includes('A late crow') || !JSON.stringify(user.content).includes('Look at this crow')) throw new Error(`Unexpected first payload: ${JSON.stringify(user.content).slice(0, 1000)}`);
    await until('one session', async () => await page.locator('.app').getAttribute('data-sessions') === '1');
    await until('late capture delivered', async () => await page.locator('main .page-capture-chip').count() === 1);
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    const secondComposer = page.locator('main .composer-input:visible');
    await secondComposer.fill('Another chat');
    await secondComposer.press('Enter');
    await until('second session', async () => await page.locator('.app').getAttribute('data-sessions') === '2');
    await add();
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await page.locator('main .page-capture-chip').count() !== 0) throw new Error('Capture went to unrelated chat');
    await page.locator(`.session-row[data-session="${firstId}"]`).click();
    await page.locator('main .page-capture-chip').waitFor({ timeout: 15_000 });
    if (process.env.VERA_PRECHAT_PROOF) await page.screenshot({ path: `${process.env.VERA_PRECHAT_PROOF}-handoff.png` });
    await evaluate(`document.querySelector('[data-vera-annotation]').shadowRoot.querySelector('button[title="Close"]').click()`);
    await until('annotation closed', async () => await pointer.getAttribute('aria-pressed') === 'false');
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await pointer.click();
    await until('toolbar reopened', async () => await evaluate("Boolean(document.querySelector('[data-vera-annotation]')?.shadowRoot?.querySelector('[role=toolbar]'))"));
    await add();
    await page.locator('main .page-capture-chip').waitFor();
    const captureOnly = page.locator('main .composer-input:visible');
    if (await captureOnly.inputValue() !== '') throw new Error('Capture-only draft unexpectedly has text');
    await captureOnly.press('Enter');
    await until('capture-only session', async () => await page.locator('.app').getAttribute('data-sessions') === '3');
    await until('capture-only payload', () => requests.some((body) => body.messages?.some((message) => message.role === 'user' && Array.isArray(message.content) && JSON.stringify(message.content).includes('A late crow'))));
    console.log('pre-chat annotation e2e passed');
} catch (error) {
    failed = true;
    console.error(error);
    console.error('provider requests:', JSON.stringify(requests.map((request) => ({ model: request.model, messages: request.messages?.map((message) => ({ role: message.role, content: JSON.stringify(message.content).slice(0, 1000) })) }))));
    if (page) console.error('page:', (await page.locator('main').innerText().catch(() => '')).slice(-5000));
    if (page && process.env.VERA_PRECHAT_PROOF) await page.screenshot({ path: `${process.env.VERA_PRECHAT_PROOF}-failure.png` }).catch(() => {});
} finally {
    await trial.cleanup();
    await Promise.all([new Promise((resolve) => provider.close(resolve)), new Promise((resolve) => fixture.close(resolve))]);
}
if (failed) process.exitCode = 1;
