// Folder reading test for the desktop shell. Run with: node clients/desktop/test/folderreading.e2e.mjs
// Customize and Settings > Agents list what a folder loads from the host while its session is stopped:
// a project skill and a project agent show up, nothing offers Start session, and no message is sent.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { press, startTrial, MODIFIER } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
const LONG_TIMEOUT = 45_000;
let turns = 0;

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
        turns += 1;
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
    mkdirSync(join(nest, ".vera", "agents"), { recursive: true });
    mkdirSync(join(nest, ".vera", "skills", "nest-check"), { recursive: true });
    writeFileSync(join(nest, ".vera", "agents", "plan.md"), "---\ndescription: Plans before it edits\n---\nPlan the nest.\n");
    writeFileSync(
        join(nest, ".vera", "skills", "nest-check", "SKILL.md"),
        "---\nname: nest-check\ndescription: Checks the nest\n---\nCount the eggs.\n",
    );

    const app = await trial.launch();
    await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, nest);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: LONG_TIMEOUT });
    await trial.waitForHost();

    // One turn in the nest gives the window a folder to offer, then the host closes the session.
    await page.locator(".folder-picker .chip-button").click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"nest\")");
    const input = page.locator(".composer-input");
    await input.fill("Tell me about crows");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: LONG_TIMEOUT });
    await page.waitForSelector(`text=${REPLY}`, { timeout: LONG_TIMEOUT });
    await until("the turn to end", async () => (await page.locator(".send-button").getAttribute("data-mode")) === "send");
    const turnsBefore = turns;
    const agentId = await page.locator("[data-session][data-phase]").first().getAttribute("data-session");
    const row = page.locator(`.session-row[data-session="${agentId}"]`);
    const closed = await page.evaluate((id) => window.veraDesktop.closeSession(id), agentId);
    if (!closed.ok) throw new Error(`The host would not close the session: ${JSON.stringify(closed)}`);
    await until("the row to show the session stopped", async () => (await row.getAttribute("data-live")) === "false", 30_000);

    // Customize lists the project's skill and agent with no session running.
    await page.locator("[data-page=\"customize\"]").first().click();
    await page.waitForSelector("main[data-page=\"customize\"]", { timeout: 10_000 });
    await page.locator(".customize-card[data-kind=\"skills\"][data-name=\"nest-check\"]").waitFor({ timeout: 30_000 });
    await page.locator(".customize-card[data-kind=\"agents\"][data-name=\"plan\"]").waitFor({ timeout: 10_000 });
    await page.locator(".customize-card[data-kind=\"skills\"][data-name=\"vera-help\"]").waitFor({ timeout: 10_000 });
    if (await page.locator("main[data-page=\"customize\"] [data-start-session]").count() !== 0) throw new Error("Customize offered Start session.");
    if (await page.locator(".empty-state", { hasText: "No session in this folder" }).count() !== 0) throw new Error("Customize says the folder has no session.");

    // Reload reads again and keeps the list.
    await page.getByRole("button", { name: "Reload" }).click();
    await page.locator(".customize-card[data-kind=\"skills\"][data-name=\"nest-check\"]").waitFor({ timeout: 30_000 });

    // Settings > Agents lists the same agent.
    await press(app, ",", [MODIFIER]);
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    await page.locator(".rail-row", { hasText: "Agents" }).click();
    await page.locator(".setting", { hasText: "Plans before it edits" }).waitFor({ timeout: 30_000 });

    // The session stayed stopped across several refreshes of the list, and no message was sent.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    if (await row.getAttribute("data-live") !== "false") throw new Error("Reading the folder started the session.");
    if (turns !== turnsBefore) throw new Error(`Reading the folder sent a message: ${turns - turnsBefore} more turns.`);
    console.log("folderreading e2e passed");
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
