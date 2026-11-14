import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const seen = [];
let calls = 0;
let imageReachedModel = false;
const server = createServer((request, response) => {
    if (request.url === "/download") {
        response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=crow.txt" });
        response.end("crow");
        return;
    }
    if (request.url.startsWith("/site")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<title>Crow page</title><h1>A crow on a ship</h1><input aria-label="Ship name"><button aria-disabled="true">Unavailable</button><button id="go" onclick="document.querySelector('#out').textContent='Button worked'">Press me</button><p id="out">Waiting</p><script>if(location.search){document.cookie='trial=fake; max-age=3600';localStorage.setItem('trial','fake')}</script>`);
        return;
    }
    if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        if (raw.includes('"image_url"') && raw.includes("Screenshot captured.")) imageReachedModel = true;
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
            return;
        }
        const messages = body.messages ?? [];
        const user = messages.findLastIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("Read and press"));
        const results = messages.slice(user + 1).filter((message) => message.role === "tool");
        seen.push(...results.map((result) => String(result.content)));
        let input;
        if (results.length === 0) input = { action: "read" };
        if (results.length === 1) {
            const ref = String(results[0].content).match(/(r\d+) button Unavailable/)?.[1];
            if (ref !== undefined) input = { action: "click", ref };
        }
        if (results.length === 2) {
            const ref = String(results[0].content).match(/(r\d+) textbox Ship name/)?.[1];
            if (ref !== undefined) input = { action: "type", ref, text: "Crow" };
        }
        if (results.length === 3) {
            const ref = String(results[0].content).match(/(r\d+) button Press me/)?.[1];
            if (ref !== undefined) input = { action: "click", ref };
        }
        if (results.length === 4) input = { action: "screenshot" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (input === undefined) response.write(streamChunk(body.model, { role: "assistant", content: "Browser turn finished." }, "stop"));
        else {
            const call = { index: 0, id: `browser-${++calls}`, type: "function", function: { name: "desktop_browser", arguments: JSON.stringify(input) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let page;
let failed = false;
try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, server.address().port, "ask");
    const configPath = join(trial.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.providers["faux-0"].images = true;
    writeFileSync(configPath, JSON.stringify(config));
    let app = await trial.launch();
    app.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').fill("Usage");
    await page.locator('input[aria-label="Command palette"]').press("Enter");
    let pane = page.locator('[data-location="rightPane"]');
    let address = pane.getByRole("textbox", { name: "Address" });
    await address.waitFor();
    const switcher = pane.getByRole("switch", { name: "Browser tools" });
    await until("browser switch ready", async () => await switcher.isEnabled());
    if (await switcher.isChecked()) throw new Error("Browser tools started on");
    await switcher.click();
    await until("browser tools on", async () => await switcher.isChecked());
    const url = `http://127.0.0.1:${server.address().port}/site?set=1`;
    await address.fill(url);
    await address.press("Enter");
    const view = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes('/site'))?.webContents.id);
    await until("site in the pane", async () => (await view()) !== undefined);
    const readSite = async (expression) => app.evaluate(async ({ webContents }, arg) => webContents.fromId(arg.id)?.executeJavaScript(arg.expression), { id: await view(), expression });
    await until("site content", async () => (await readSite("document.title")) === "Crow page");
    await address.fill(`http://127.0.0.1:${server.address().port}/site?next=1`);
    await address.press("Enter");
    await until("second address", async () => (await readSite("location.search").catch(() => "")) === "?next=1");
    await pane.getByRole("button", { name: "Back", exact: true }).click();
    await until("back", async () => (await readSite("location.search").catch(() => "")) === "?set=1");
    await pane.getByRole("button", { name: "Forward", exact: true }).click();
    await until("forward", async () => (await readSite("location.search").catch(() => "")) === "?next=1");
    await readSite("(() => { for (let i = 0; i < 160; i++) { const b = document.createElement('button'); b.textContent = 'Extra ' + i; document.body.append(b); } return true; })()");
    if ((statSync(join(trial.home, "machine", "desktop", "browser")).mode & 0o777) !== 0o700) throw new Error("Browser directory is not private");
    if ((statSync(join(trial.home, "machine", "desktop", "browser", "Cookies")).mode & 0o777) !== 0o600) throw new Error("Cookie file is not private");
    await app.evaluate(({ app: electronApp, session }, home) => {
        const browser = session.fromPath(`${home}/machine/desktop/browser`);
        browser.once("will-download", (event, item) => {
            event.preventDefault();
            globalThis.downloadDefaults = item.getSaveDialogOptions().defaultPath === `${electronApp.getPath("downloads")}/crow.txt`;
        });
    }, trial.home);
    await readSite("(() => { const a = document.createElement('a'); a.href = '/download'; a.click(); return true; })()");
    await until("download prompt defaults", async () => await app.evaluate(() => globalThis.downloadDefaults === true));
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').waitFor();
    await until("view hidden under palette", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes('/site'))?.getVisible() === false));
    await page.keyboard.press("Escape");
    await until("view restored", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes('/site'))?.getVisible() === true));
    const input = page.locator(".composer-input");
    await input.fill("Read and press the button");
    await input.press("Enter");
    const card = page.locator('.request-card[data-kind="approval"]');
    for (let i = 0; i < 5; i += 1) {
        await card.waitFor({ timeout: 30_000 });
        await card.getByRole("button", { name: /Allow once/ }).click();
        await card.waitFor({ state: "detached", timeout: 15_000 });
    }
    await page.getByText("Browser turn finished.").waitFor({ timeout: 30_000 });
    if (!seen.some((result) => result.includes("A crow on a ship"))) throw new Error("Page read did not reach the model");
    if ((seen[0].match(/^r\d+ /gm) ?? []).length !== 150) throw new Error("The accessibility snapshot was not capped");
    if (!seen.some((result) => result.includes("Clicked."))) throw new Error("Click result did not reach the model");
    if (!seen.some((result) => result.includes("hidden, covered, or disabled"))) throw new Error("Disabled target was not refused");
    if (!seen.some((result) => result.includes("Typed."))) throw new Error("Type result did not reach the model");
    if (!seen.some((result) => result.includes("Screenshot captured."))) throw new Error("Screenshot result did not reach the model");
    if (!imageReachedModel) throw new Error("Screenshot image did not reach the model");
    const captures = join(trial.home, "extension-data", "vera.desktop-browser", "captures");
    if (readdirSync(captures).length === 0) throw new Error("Screenshot capture was not stored");
    if ((await readSite("document.querySelector('#out').textContent")) !== "Button worked") throw new Error("The page button was not clicked");
    if ((await readSite("document.querySelector('input').value")) !== "Crow") throw new Error("The page input was not filled");
    await page.locator('.pill-button[data-mode="ask"]').click();
    await page.locator('[role="menu"]').first().waitFor();
    await until("view hidden under menu", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes('/site'))?.getVisible() === false));
    await page.keyboard.press("Escape");
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').fill("Choose Theme");
    await page.locator('input[aria-label="Command palette"]').press("Enter");
    await page.locator('[data-overlay="themes"]').waitFor();
    await until("view hidden under sheet", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes('/site'))?.getVisible() === false));
    await page.keyboard.press("Escape");
    await until("view restored after sheet", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes('/site'))?.getVisible() === true));
    await readSite("(() => { window.open('/site'); return true; })()");
    await until("popup tab", async () => (await pane.locator('nav[aria-label="Browser tabs"] button[aria-label^="Close "]').count()) === 2);
    await until("popup page", async () => (await readSite("document.title").catch(() => "")) === "Crow page");
    if (!(await readSite("document.cookie")).includes("trial=fake")) throw new Error("Popup did not use the browser session");
    if ((await readSite("typeof process + ':' + typeof require")) !== "undefined:undefined") throw new Error("Popup has node access");
    await pane.locator('nav[aria-label="Browser tabs"] button[aria-label^="Close "]').last().click();
    await until("popup closed", async () => (await pane.locator('nav[aria-label="Browser tabs"] button[aria-label^="Close "]').count()) === 1);
    await app.close();
    app = await trial.launch();
    app.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions]', { timeout: 45_000 });
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').fill("Usage");
    await page.locator('input[aria-label="Command palette"]').press("Enter");
    pane = page.locator('[data-location="rightPane"]');
    address = pane.getByRole("textbox", { name: "Address" });
    await address.waitFor();
    await until("switch persists", async () => await pane.getByRole("switch", { name: "Browser tools" }).isChecked());
    await address.fill(`http://127.0.0.1:${server.address().port}/site`);
    await address.press("Enter");
    await until("site after restart", async () => (await view()) !== undefined);
    await until("page after restart", async () => (await readSite("document.title")) === "Crow page");
    if (!(await readSite("document.cookie")).includes("trial=fake") || (await readSite("localStorage.getItem('trial')")) !== "fake") throw new Error("Sign-in data did not survive restart");
    await pane.getByRole("button", { name: "Forget browsing data" }).click();
    await until("captures cleared", async () => readdirSync(captures).length === 0);
    await until("site closed", async () => (await view()) === undefined);
    await address.fill(`http://127.0.0.1:${server.address().port}/site`);
    await address.press("Enter");
    await until("site reopened", async () => (await view()) !== undefined);
    await until("site reloaded", async () => (await readSite("document.title")) === "Crow page");
    if ((await readSite("document.cookie")) !== "" || (await readSite("localStorage.getItem('trial')")) !== null) throw new Error("Browsing data survived forget");
    console.log("browser sites e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Tool results:", seen);
    if (page !== undefined) console.error(await page.locator(".app").innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}
process.exit(failed ? 1 : 0);
