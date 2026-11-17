import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MODIFIER, press, startTrial } from "./trial.mjs";

const trial = startTrial();
let app;
let hostPid;

function exited(pid) {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
    }
}

try {
    const extension = join(trial.home, "machine", "desktop", "extensions", "crow");
    mkdirSync(join(extension, "themes"), { recursive: true });
    writeFileSync(join(extension, "vera.desktop.json"), JSON.stringify({
        id: "crow", version: "1.0.0", engine: "vera-gui@^1",
        contributes: { themes: [{ label: "Crow Night", path: "themes/night.json" }] },
    }));
    writeFileSync(join(extension, "themes", "night.json"), JSON.stringify({
        version: 1, slug: "night", name: "Crow Night", type: "dark", source: "Crow",
        colors: { surface: "#101820", text: "#e0e5eb" }, values: {}, tokenColors: [], semanticTokenColors: {},
    }));
    app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    hostPid = await trial.waitForHost();
    await press(app, "K", [MODIFIER]);
    const input = page.getByRole("textbox", { name: "Command palette", exact: true });
    const rows = page.locator('.palette[data-overlay="palette"] [role="option"]');
    const selected = page.locator('.palette[data-overlay="palette"] [aria-selected="true"]');
    const selectedId = async (id) => {
        await page.waitForFunction((expected) => document.querySelector('.palette[data-overlay="palette"] [aria-selected="true"]')?.getAttribute("data-command") === expected, id);
    };
    await rows.first().waitFor();
    for (const query of ["", "   "]) {
        await input.fill(query);
        const emptyIds = await rows.evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-command")));
        assert(!emptyIds.some((id) => id.startsWith("theme.") && id !== "theme.choose"));
        assert(emptyIds.includes("theme.choose"));
        assert(emptyIds.includes("vera.vscode-theme-import.import"));
        assert(emptyIds.includes("vera.vscode-theme-import.installed"));
    }
    await input.fill("crow night");
    await selectedId("theme.imported.crow.night");
    await input.press("Enter");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "imported:crow.night");
    await press(app, "K", [MODIFIER]);
    await input.fill("palenight");
    await selectedId("theme.palenight");
    await input.press("Enter");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "palenight");
    await press(app, "K", [MODIFIER]);
    await input.fill("theme");
    const ids = await rows.evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-command")));
    await selectedId(ids[0]);
    assert.deepEqual(new Set(ids), new Set([
        "theme.choose",
        "vera.vscode-theme-import.import",
        "vera.vscode-theme-import.installed",
    ]));
    console.log(`theme screen order: ${ids.join(", ")}`);
    for (const id of [...ids.slice(1), ids[0]]) {
        await input.press("ArrowDown");
        await selectedId(id);
    }
    console.log(`Down follows all ${ids.length} visible rows, then wraps to the first row`);
    for (const id of [...ids.slice(1).reverse(), ids[0]]) {
        await input.press("ArrowUp");
        await selectedId(id);
    }
    console.log("Up mirrors the visible order and wraps from the first row to the last row");
    await input.press("ArrowDown");
    await selectedId(ids[1]);
    await input.fill("them");
    await selectedId(ids[0]);
    await input.fill("theme");
    await input.press("ArrowUp");
    await selectedId(ids.at(-1));
    await input.press("ArrowDown");
    await selectedId(ids[0]);
    await input.fill("");
    const emptyFirst = await rows.first().getAttribute("data-command");
    await selectedId(emptyFirst);
    await input.press("ArrowDown");
    await selectedId(await rows.nth(1).getAttribute("data-command"));
    console.log("empty and whitespace hide individual themes; built-in and installed theme search and execution work; clearing resets selection");
    await input.fill("theme");
    console.log("typing resets to the first row; Up and Down wrap in screen order");

    await page.locator('.palette [data-command="theme.choose"]').hover();
    await selectedId("theme.choose");
    assert.match(await selected.innerText(), /Choose Theme/);
    await input.press("ArrowDown");
    await selectedId(ids[(ids.indexOf("theme.choose") + 1) % ids.length]);
    await input.press("ArrowUp");
    await selectedId("theme.choose");
    await input.press("Enter");
    await page.waitForSelector('[data-overlay="themes"]', { timeout: 5_000 });
    console.log("hover, arrows and Enter agree: Choose Theme opens the theme sheet");
    console.log("palette e2e passed");
} finally {
    const electronPid = app?.process().pid;
    await trial.cleanup();
    for (const pid of [electronPid, hostPid]) {
        if (pid === undefined) continue;
        for (let attempt = 0; attempt < 100 && !exited(pid); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(exited(pid), `Trial process ${pid} is still running`);
    }
    assert(!existsSync(trial.trialRoot), "Trial home was not removed");
    console.log("trial cleanup verified: Electron and host exited; trial home removed");
}
