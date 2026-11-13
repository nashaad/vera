// Models > Defaults test for the desktop shell, launched from a folder outside the checkout.
// Run with: node clients/desktop/test/defaults.e2e.mjs

import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const RAVEN = {
    id: "crow-1",
    label: "Raven",
    context_window: 32000,
    tool_support: true,
    levels: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
    default_level: "high",
    pricing: { input: 2, output: 8 },
};

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }, { id: "crow-1" }] }));
        return;
    }
    request.resume();
    request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            id: "reply",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
    });
});

const trial = startTrial();
let failed = false;
let page;

const assignments = () => JSON.parse(readFileSync(join(trial.home, "config.json"), "utf8")).model_assignments ?? {};
const names = (slot) => (assignments()[slot]?.models ?? []).map((entry) => `${entry.model}${entry.reasoning_effort === undefined ? "" : `@${entry.reasoning_effort}`}`);

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto", [RAVEN]);
    const elsewhere = join(trial.trialRoot, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });

    const app = await trial.launch({ cwd: elsewhere });
    const cwd = await app.evaluate(() => process.cwd());
    if (cwd.replace(/^\/private/, "") !== elsewhere.replace(/^\/private/, "")) throw new Error(`The app runs in ${cwd}, not ${elsewhere}.`);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    const modelPill = page.locator(".model-pill");
    await until("the model pill", async () => /crow/i.test(await modelPill.innerText()));
    await modelPill.click();
    await page.getByRole("button", { name: /All models/ }).click();
    await page.waitForSelector(".models-sheet");
    await page.locator(".models-tab", { hasText: "Defaults" }).click();

    const row = (label) => page.locator(".slot-row", { has: page.locator(".slot-row-name", { hasText: new RegExp(`^${label}$`) }) });
    const button = (label) => row(label).locator(".slot-btn");
    const picker = page.locator(".slot-picker");
    const toast = (text) => page.waitForSelector(`.toast-text:has-text("${text}")`, { timeout: 15_000 });
    await until("Crow on Eco", async () => /Crow/.test(await button("Eco").innerText()));

    // Escape closes the picker and leaves the browser open.
    await button("Snappy").click();
    await picker.waitFor();
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 5_000 });
    if (await page.locator(".models-sheet").count() !== 1) throw new Error("Escape in a picker closed the models browser.");

    // Eco to Raven at Low: Raven is off the favorites, so assigning it adds it there too.
    await button("Eco").click();
    await picker.waitFor();
    if ((await picker.locator(".slot-pick-title").innerText()) !== "Assign a model to eco") throw new Error("The picker names the wrong slot.");
    await picker.locator("input").fill("raven");
    await picker.locator(".slot-pick-effort", { hasText: "Low" }).click();
    await toast("Eco now uses Raven at low effort, and it is now a favorite");
    await until("crow-1 at low in config.json", async () => names("eco").join() === "crow-1@low");
    await until("Raven on Eco", async () => /Raven/.test(await button("Eco").innerText()));
    const pooled = () => page.evaluate(async () => {
        const reply = await window.veraDesktop.readModelSettings();
        return (reply.settings?.pooled ?? []).map((entry) => `${entry.provider}/${entry.model}`);
    });
    await until("Raven among the favorites", async () => (await pooled()).includes("faux-0/crow-1"));

    // Clearing Compaction leaves it on Eco, which now runs Raven.
    await button("Compaction").click();
    await picker.waitFor();
    if (!(await picker.locator(".model-item-desc").innerText()).includes("Uses Eco, now Raven")) throw new Error("The clearing row does not say Compaction falls back to Eco.");
    await page.keyboard.press("Enter");
    await toast("Compaction is not set");
    await until("compaction cleared in config.json", async () => names("compaction").length === 0);
    await until("Compaction leaning on Eco", async () => /Uses Eco/.test(await button("Compaction").innerText()));
    if (!(await row("Eco").innerText()).includes("compaction")) throw new Error("Eco does not say compaction uses it.");

    // A subagent model joins the list, and the switch writes allow_self.
    await row("Subagents").locator(".slot-btn").click();
    await picker.waitFor();
    await picker.locator("input").fill("crow");
    await picker.locator(".slot-pick", { hasText: "Crow" }).click();
    await toast("Subagents can now run Crow, first in order");
    await until("crow-0 in subagents", async () => names("subagents").includes("crow-0"));
    await page.getByRole("switch", { name: "Then the spawning session's model" }).click();
    await until("allow_self in config.json", async () => assignments().subagents?.allow_self === true);

    console.log("defaults e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Assignments:", JSON.stringify(assignments(), null, 1));
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
