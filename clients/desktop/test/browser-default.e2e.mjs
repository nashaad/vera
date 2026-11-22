import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const PANE_SENTENCE = "If a tool named browser is also available, use this tool unless the user asks for Chrome.";
const prompt = "Which browser should answer this?";
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
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { role: "assistant", content: "Browser choice recorded." }, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "ask");
    const app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await until("Browser settings available", async () => (await page.evaluate(() => window.veraDesktop.browser(""))).toolsAvailable);

    const settingsPath = join(trial.home, "extension-data", "vera.builtin-browser", "settings.json");
    const stored = () => {
        try { return JSON.parse(readFileSync(settingsPath, "utf8")).defaultBrowser; } catch { return undefined; }
    };
    const initial = await page.evaluate(() => window.veraDesktop.browser(""));
    if (initial.defaultBrowser !== "ask") throw new Error(`Default browser did not start on ask: ${JSON.stringify(initial)}`);

    const chrome = await page.evaluate(() => window.veraDesktop.browser("defaultBrowser", "chrome"));
    if (chrome.defaultBrowser !== "chrome") throw new Error(`IPC did not apply Chrome: ${JSON.stringify(chrome)}`);
    await until("Chrome stored", () => stored() === "chrome");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('main[data-page="settings"]').waitFor();
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const row = page.locator('main[data-page="settings"]').getByText("Default browser", { exact: true });
    await row.waitFor();
    const paneButton = page.getByRole("button", { name: "Browser pane", exact: true });
    await until("Default browser control enabled", () => paneButton.isEnabled());
    if (await paneButton.getAttribute("aria-pressed") !== "false") throw new Error("Browser pane started pressed");
    await paneButton.click();
    await until("Browser pane stored", () => stored() === "pane");
    if (await paneButton.getAttribute("aria-pressed") !== "true") throw new Error("Browser pane did not become pressed");

    const composer = page.locator(".home-composer .composer-input");
    await page.locator('button[data-page="home"]').click();
    await composer.waitFor();
    await composer.fill(prompt);
    await composer.press("Enter");
    await page.getByText("Browser choice recorded.").waitFor({ timeout: 45_000 });
    const sent = requests.find((body) => JSON.stringify(body.messages ?? []).includes(prompt));
    const description = (sent?.tools ?? []).find((tool) => tool.function?.name === "builtin_browser")?.function?.description;
    if (!description?.endsWith(PANE_SENTENCE)) throw new Error(`The next request did not carry the Browser pane sentence: ${description}`);
    console.log("Default browser IPC, storage, Settings row and next model request passed");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    try {
        await trial.cleanup();
    } catch (error) {
        failed = true;
        console.error(`Trial retained at ${trial.trialRoot}:`, error);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
