// Notes offer test for the desktop shell. Run with: node clients/desktop/test/notesoffer.e2e.mjs
// Settings > Agents > Suggest keeping notes decides whether a session created afterwards carries the notes offer.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
const LONG_TIMEOUT = 45_000;
const requests = [];

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        const messages = body.messages ?? [];
        const system = messages.find((message) => message.role === "system");
        // The title request has no tools; the conversation's own requests do.
        requests.push({
            turn: Array.isArray(body.tools) && body.tools.length > 0,
            system: JSON.stringify(system?.content ?? ""),
            users: JSON.stringify(messages.filter((message) => message.role === "user").map((message) => message.content)),
        });
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { role: "assistant", content: REPLY }, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);

    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: LONG_TIMEOUT });
    await trial.waitForHost();

    const input = page.locator(".composer-input");
    const startSession = async (text) => {
        await input.fill(text);
        await input.press("Enter");
        await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: LONG_TIMEOUT });
        await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
        return page.locator("[data-session][data-phase=\"attached\"]").first().getAttribute("data-session");
    };
    const newChat = async () => {
        await page.click(".nav-row[data-page=\"home\"]");
        await page.waitForSelector("main[data-page=\"home\"]");
    };
    const headerOf = (id) => {
        const first = readFileSync(join(trial.home, "runtime", "sessions", `${id}.jsonl`), "utf8").split("\n")[0];
        return JSON.parse(first);
    };
    const turnsOf = (text) => requests.filter((entry) => entry.turn && entry.users.includes(JSON.stringify(text)));
    const hasNotes = (text) => {
        const turns = turnsOf(text);
        if (turns.length === 0) throw new Error(`The provider never saw a turn for "${text}".`);
        return turns.map((entry) => entry.system.includes("## Notes"));
    };
    const openAgentsSettings = async () => {
        await press(app, "K", [MODIFIER]);
        const palette = page.locator("input[aria-label=\"Command palette\"]");
        await palette.waitFor({ timeout: 10_000 });
        await palette.fill("settings");
        await page.locator(".palette-row[data-command=\"go.settings\"]").waitFor({ timeout: 10_000 });
        await palette.press("Enter");
        await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
        await page.locator(".rail-row", { hasText: "Agents" }).click();
        return page.getByRole("switch", { name: "Suggest keeping notes" });
    };

    // The setting is on by default, and a session created while it is on carries the offer.
    const first = await startSession("Hello offered");
    if (headerOf(first).notesOffer !== true) throw new Error("A session created with the setting on has no notes offer.");
    if (!hasNotes("Hello offered").every(Boolean)) throw new Error("The first session's prompt has no notes section.");

    // Turning it off applies to the next session only.
    const setting = await openAgentsSettings();
    if ((await setting.getAttribute("aria-checked")) !== "true") throw new Error("Suggest keeping notes is not on by default.");
    await setting.click();
    if ((await setting.getAttribute("aria-checked")) !== "false") throw new Error("The switch did not turn off.");
    await newChat();
    const second = await startSession("Hello plain");
    if ("notesOffer" in headerOf(second)) throw new Error("A session created with the setting off carries the notes offer.");
    if (hasNotes("Hello plain").some(Boolean)) throw new Error("The second session's prompt has a notes section.");
    if (headerOf(first).notesOffer !== true) throw new Error("Turning the setting off changed an earlier session.");

    // The first session keeps its offer on every later turn.
    await page.click(`.session-row[data-session="${first}"]`);
    await page.waitForSelector(`[data-session="${first}"][data-phase="attached"]`, { timeout: LONG_TIMEOUT });
    await input.fill("Hello again");
    await input.press("Enter");
    await until("the follow-up turn", async () => turnsOf("Hello offered").length >= 2);
    if (!hasNotes("Hello offered").every(Boolean)) throw new Error("A later turn of the first session lost the notes section.");

    // The switch reads the stored choice again when Settings opens, and turning it on applies to the next session.
    const again = await openAgentsSettings();
    if ((await again.getAttribute("aria-checked")) !== "false") throw new Error("The setting did not stay off.");
    await again.click();
    await newChat();
    const third = await startSession("Hello offered again");
    if (headerOf(third).notesOffer !== true) throw new Error("A session created after turning the setting on again has no notes offer.");
    console.log("notesoffer e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests.map((entry) => ({ turn: entry.turn, users: entry.users.slice(0, 80), notes: entry.system.includes("## Notes") })));
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
