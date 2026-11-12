// Pages test for the desktop shell. Run with: node clients/desktop/test/pages.e2e.mjs
// One session says a rare word; Search finds it, Work shows a slow turn finishing
// while another page is open, the Workspace page counts the folder's sessions,
// Devices describes this machine, Customize lists what the folder's session can use,
// and the command palette and shortcuts sheet open from their keys.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const RARE = "Quillfeather";
const REPLY = `The heron counts ${RARE} stones by the reef.`;
// Sessions refresh every few seconds, so the slow turn outlasts several refreshes.
const SLOW_CHUNKS = 30;
const SLOW_CHUNK_MS = 300;

function lastUserText(body) {
    const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    return JSON.stringify(user?.content ?? "");
}

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", async () => {
        const body = JSON.parse(raw);
        const slow = lastUserText(body).includes("SLOW");
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Heron notes" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        let closed = false;
        response.on("close", () => { closed = true; });
        const parts = slow ? Array.from({ length: SLOW_CHUNKS }, () => " tide") : REPLY.split(/(?= )/);
        for (const part of parts) {
            if (closed) return;
            response.write(streamChunk(body.model, { content: part }));
            await new Promise((resolve) => setTimeout(resolve, slow ? SLOW_CHUNK_MS : 20));
        }
        if (closed) return;
        response.write(streamChunk(body.model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

async function press(app, key, modifiers) {
    await app.evaluate(({ BrowserWindow }, { key, modifiers }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    }, { key, modifiers });
}

async function openPage(kind) {
    await page.locator(`[data-page="${kind}"]`).first().click();
    await page.waitForSelector(`main[data-page="${kind}"]`, { timeout: 10_000 });
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "nest");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"nest\")");
    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    await input.fill("Tell me about herons");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 45_000 });
    await until("the turn to end", async () => (await send.getAttribute("data-mode")) === "send");

    // Search finds the session by what was said in it, and marks the word.
    await openPage("search");
    await page.locator("input[aria-label=\"Search sessions\"]").fill(RARE.toLowerCase());
    const hit = page.locator(".list-row[data-session]").first();
    await hit.waitFor({ timeout: 15_000 });
    const marked = await hit.locator(".search-mark").first().innerText();
    if (marked !== RARE) throw new Error(`Search marked ${marked}`);
    await page.locator("input[aria-label=\"Search sessions\"]").fill("albatross");
    await page.locator(".empty-state-title", { hasText: "No matches" }).waitFor({ timeout: 15_000 });
    await page.locator("input[aria-label=\"Search sessions\"]").fill(RARE);
    await hit.click();
    await page.waitForSelector(`text=${REPLY}`, { timeout: 15_000 });

    // A slow turn runs while Work is open, then lands in Finished since nobody looked.
    await input.fill("SLOW tide");
    await input.press("Enter");
    await until("the slow turn to start", async () => (await send.getAttribute("data-mode")) !== "send");
    await openPage("work");
    await page.locator("section[data-bucket=\"running\"]").locator(".list-row").first().waitFor({ timeout: 15_000 });
    await page.locator("section[data-bucket=\"finished\"]").locator(".list-row").first()
        .waitFor({ timeout: 30_000 });

    // The sidebar group title opens the folder's Workspace page.
    await page.locator(".group-title", { hasText: "nest" }).first().click();
    await page.waitForSelector("main[data-page=\"workspace\"]", { timeout: 10_000 });
    const sessions = await page.locator(".stat", { hasText: "Sessions" }).locator(".stat-value").innerText();
    if (sessions.trim() !== "1") throw new Error(`Workspace counted ${sessions} sessions`);
    await page.getByRole("button", { name: "New chat here" }).click();
    await page.waitForSelector("main[data-page=\"home\"] .context-chips .chip-label:text-is(\"nest\")", { timeout: 10_000 });

    // Devices describes this machine and nothing else.
    await openPage("devices");
    await page.locator(".list-row-title", { hasText: "This Mac" }).click();
    await page.locator(".device-state", { hasText: "Connected" }).waitFor({ timeout: 10_000 });

    // Customize reads the catalogs through the folder's session; Vera's own help skill is always there.
    await openPage("customize");
    await page.locator(".customize-card[data-kind=\"skills\"][data-name=\"vera-help\"]").waitFor({ timeout: 20_000 });
    await page.locator(".customize-card[data-name=\"vera-help\"]").click();
    await page.waitForSelector("[data-overlay=\"customize-detail\"]", { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-overlay=\"customize-detail\"]", { state: "detached", timeout: 10_000 });

    // Discover has no catalog to list, and says so.
    await page.locator(".customize-seg button", { hasText: "Discover" }).click();
    await page.locator(".empty-state-title", { hasText: "Nothing to browse" }).waitFor({ timeout: 10_000 });

    // Coverage lists what the window does, and the Tour opens the session by its status.
    await openPage("tour");
    await page.locator(".page-head .ghost-btn", { hasText: "Coverage" }).click();
    await page.waitForSelector("main[data-page=\"coverage\"] .coverage-row", { timeout: 10_000 });
    await page.locator(".page-head .ghost-btn", { hasText: "Tour" }).click();
    const sessionCard = page.locator(".tour-card[data-card=\"completed\"]:not([disabled]), .tour-card[data-card=\"idle\"]:not([disabled])");
    await sessionCard.first().click({ timeout: 10_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 15_000 });

    // The command palette runs a command by name.
    const modifier = process.platform === "darwin" ? "meta" : "control";
    await press(app, "K", [modifier]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("settings");
    await page.locator(".palette-row[data-command=\"go.settings\"]").waitFor({ timeout: 10_000 });
    await palette.press("Enter");
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    if (await page.locator("[data-overlay=\"palette\"]").count() !== 0) throw new Error("The palette stayed open after running a command.");

    // Settings > Data counts this home's sessions.
    await page.locator(".rail-row", { hasText: "Data" }).click();
    await page.locator(".setting", { hasText: "Desktop folder" }).waitFor({ timeout: 10_000 });
    await until("the session count", async () => /\b1\b/.test(await page.locator(".setting", { hasText: "Sessions" }).first().innerText()));

    // Settings > Keyboard and the shortcuts sheet list the palette's keys.
    await page.locator(".rail-row", { hasText: "Keyboard" }).click();
    await page.locator(".settings-col").getByText("Command Palette", { exact: true }).first().waitFor({ timeout: 10_000 });
    await press(app, "/", [modifier]);
    const sheet = page.locator("[data-overlay=\"shortcuts\"]");
    await sheet.getByText("Command Palette", { exact: true }).first().waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: 10_000 });

    // Full access stays out of the approval menus until Settings > Approvals turns it on, and turning it on asks first.
    const approvalModes = async () => {
        await press(app, "N", [modifier]);
        const pill = page.locator(".home-composer .approval-picker .pill-button");
        await pill.waitFor({ timeout: 10_000 });
        await pill.click();
        await page.locator(".approval-menu").waitFor({ timeout: 5_000 });
        const names = await page.locator(".approval-menu .approval-item-name").allInnerTexts();
        await page.keyboard.press("Escape");
        await page.locator(".approval-menu").waitFor({ state: "detached", timeout: 5_000 });
        return names;
    };
    if ((await approvalModes()).includes("Full access")) throw new Error("New Chat offers Full access before it was turned on.");
    await press(app, ",", [modifier]);
    await page.locator(".rail-row", { hasText: "Approvals" }).click();
    const offer = page.getByRole("switch", { name: "Offer Full access" });
    await offer.waitFor({ timeout: 10_000 });
    if (await offer.getAttribute("aria-checked") !== "false") throw new Error("Offer Full access starts on.");
    await offer.click();
    const ask = page.locator(".setting-confirm");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await ask.waitFor({ state: "detached", timeout: 5_000 });
    if (await offer.getAttribute("aria-checked") !== "false") throw new Error("Cancel turned Full access on.");
    await offer.click();
    await ask.getByRole("button", { name: "Offer Full access" }).click();
    await until("Full access on", async () => await offer.getAttribute("aria-checked") === "true");
    if (!(await approvalModes()).includes("Full access")) throw new Error("New Chat does not offer Full access after it was turned on.");

    // Go to Session opens the session by name.
    await press(app, "P", [modifier]);
    const finder = page.locator("input[aria-label=\"Go to session\"]");
    await finder.waitFor({ timeout: 10_000 });
    await page.locator(".palette-row[data-session]").first().click();
    await page.waitForSelector(`text=${REPLY}`, { timeout: 15_000 });
    console.log("pages e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
