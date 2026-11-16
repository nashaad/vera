// New chat agent test for the desktop shell. Run with: node clients/desktop/test/newchatagent.e2e.mjs
// A new chat offers the agents of its folder before a session exists. The agent picked from the pill is
// the one the first turn runs as, a pick the next folder does not offer falls back to the default, and
// a chat that picks nothing starts on the default.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
const MARKER = "CROW-PLAN-MARKER";
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
        requests.push({
            // The title request is not streamed; the conversation's own requests are.
            turn: body.stream !== false,
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
    const nest = join(trial.home, "..", "nest");
    const shore = join(trial.home, "..", "shore");
    mkdirSync(join(nest, ".vera", "agents"), { recursive: true });
    mkdirSync(shore, { recursive: true });
    writeFileSync(
        join(nest, ".vera", "agents", "plan.md"),
        `---\ndescription: Plans before it edits\n---\n${MARKER}: answer as the planner of this nest.\n`,
    );

    const app = await trial.launch();
    const chooseFolderAs = (path) => app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, path);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: LONG_TIMEOUT });
    await trial.waitForHost();

    const pill = page.locator(".composer-bar [data-agent]");
    const sheetPick = (name) => page.locator(`[data-overlay="agent"] .dialog-pick[data-agent="${name}"]`);
    const openFolder = async (path, label) => {
        await chooseFolderAs(path);
        await page.locator(".folder-picker .chip-button").click();
        await page.getByRole("menuitem", { name: /Open folder/ }).click();
        await page.waitForSelector(`.context-chips .chip-label:text-is("${label}")`);
    };
    const newChat = async () => {
        await page.click(".nav-row[data-page=\"home\"]");
        await page.waitForSelector("main[data-page=\"home\"]");
    };
    const turnsOf = (text) => requests.filter((entry) => entry.turn && entry.users.includes(JSON.stringify(text)));
    const startSession = async (text) => {
        const input = page.locator(".composer-input");
        await input.fill(text);
        await input.press("Enter");
        await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: LONG_TIMEOUT });
        await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
    };

    // With no folder the pill names the default and the sheet lists the chat's agents, not the folder's.
    await pill.waitFor({ timeout: 15_000 });
    if ((await pill.getAttribute("data-agent")) !== "default") throw new Error("A new chat does not start on the default agent.");
    await pill.click();
    await page.waitForSelector("[data-overlay=\"agent\"] .dialog-pick", { timeout: 10_000 });
    if (await sheetPick("plan").count() !== 0) throw new Error("A chat with no folder lists a project agent.");
    if (await sheetPick("default").count() !== 1) throw new Error("The sheet does not list the default agent.");
    await page.keyboard.press("Escape");

    // A folder with a project agent offers it, picking it from the sheet shows it on the pill.
    await openFolder(nest, "nest");
    await pill.waitFor({ timeout: 15_000 });
    await pill.click();
    await sheetPick("plan").waitFor({ timeout: 15_000 });
    await sheetPick("plan").click();
    await page.waitForSelector("[data-overlay=\"agent\"]", { state: "detached", timeout: 10_000 });
    if ((await pill.getAttribute("data-agent")) !== "plan") throw new Error("The pill does not show the picked agent.");

    // Another folder that does not offer the pick sends the pill back to the default and says so.
    await openFolder(shore, "shore");
    await until("the pill to fall back", async () => (await pill.getAttribute("data-agent")) === "default");
    await page.locator(".composer-notice", { hasText: "The plan agent is not offered here. This chat starts on default." }).waitFor({ timeout: 10_000 });

    // Back in the nest, /agent with a name picks directly, once the nest's list has been read.
    await openFolder(nest, "nest");
    await pill.click();
    await sheetPick("plan").waitFor({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-overlay=\"agent\"]", { state: "detached", timeout: 10_000 });
    await page.locator(".composer-input").fill("/agent plan");
    await page.locator(".composer-input").press("Enter");
    await page.locator(".composer-notice", { hasText: "Agent: plan" }).waitFor({ timeout: 10_000 });
    if ((await pill.getAttribute("data-agent")) !== "plan") throw new Error("/agent plan did not move the pill.");

    // The first turn runs as the picked agent: the provider sees its prompt in the system message, in every request of that turn.
    await page.locator(".composer-input").fill("Plan the crow route");
    await page.locator(".composer-input").press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: LONG_TIMEOUT });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
    const planned = turnsOf("Plan the crow route");
    if (planned.length === 0) throw new Error("The provider never saw the first turn.");
    if (!planned.every((entry) => entry.system.includes(MARKER))) {
        throw new Error("The first turn did not run as the picked agent.");
    }

    // A chat in the same folder that picks nothing starts on the default, with no switch sent.
    await newChat();
    await openFolder(nest, "nest");
    await pill.waitFor({ timeout: 15_000 });
    if ((await pill.getAttribute("data-agent")) !== "default") throw new Error("A new chat in the nest did not start on the default agent.");
    await startSession("Hello plain crow");
    const plain = turnsOf("Hello plain crow");
    if (plain.length === 0) throw new Error("The provider never saw the second turn.");
    if (plain.some((entry) => entry.system.includes(MARKER))) throw new Error("A chat that picked nothing ran as the project agent.");
    console.log("newchatagent e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests.map((entry) => ({ turn: entry.turn, users: entry.users.slice(0, 80), marker: entry.system.includes(MARKER) })));
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
