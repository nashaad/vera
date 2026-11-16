import assert from "node:assert/strict";
import { existsSync } from "node:fs";

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
    app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    hostPid = await trial.waitForHost();
    await press(app, "K", [MODIFIER]);
    const input = page.getByRole("textbox", { name: "Command palette", exact: true });
    await input.fill("theme");
    const rows = page.locator('.palette[data-overlay="palette"] [role="option"]');
    const selected = page.locator('.palette[data-overlay="palette"] [aria-selected="true"]');
    const selectedId = async (id) => {
        await page.waitForFunction((expected) => document.querySelector('.palette[data-overlay="palette"] [aria-selected="true"]')?.getAttribute("data-command") === expected, id);
    };
    await selectedId("theme.dark");
    const ids = await rows.evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-command")));
    console.log(`theme screen order: ${ids.join(", ")}`);
    assert.deepEqual(ids, [
        "theme.dark",
        "theme.light",
        "theme.highContrast",
        "theme.choose",
        "vera.vscode-theme-import.import",
        "vera.vscode-theme-import.installed",
    ]);
    for (const id of [...ids.slice(1), ids[0]]) {
        await input.press("ArrowDown");
        await selectedId(id);
    }
    console.log("Down follows Dark, Light, High Contrast, Choose Theme, both import rows, then wraps to Dark");
    for (const id of [...ids.slice(1).reverse(), ids[0]]) {
        await input.press("ArrowUp");
        await selectedId(id);
    }
    console.log("Up mirrors the visible order and wraps from Dark to the last row");
    await input.press("ArrowDown");
    await selectedId("theme.light");
    await input.fill("them");
    await selectedId(ids[0]);
    await input.fill("theme");
    await input.press("ArrowUp");
    await selectedId(ids.at(-1));
    await input.press("ArrowDown");
    await selectedId(ids[0]);
    console.log("typing resets to the first row; Up and Down wrap in screen order");

    await page.locator('.palette [data-command="theme.choose"]').hover();
    await selectedId("theme.choose");
    assert.match(await selected.innerText(), /Choose Theme/);
    await input.press("ArrowDown");
    await selectedId(ids[ids.indexOf("theme.choose") + 1]);
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
