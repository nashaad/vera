// Measures desktop transcript rendering on a seeded session: streaming in the foreground and the background, then a scroll back through history.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { configureFauxHome } from "../test/faux-home.mjs";
import { startTrial } from "../test/trial.mjs";
import { startBenchProvider } from "./provider.mjs";

const root = new URL("../../..", import.meta.url).pathname;
const CPU_ROLES = ["renderer", "gpu-process", "electron-main"];
const MEMORY_ROLES = ["electron-main", "gpu-process", "renderer", "utility:network"];
const SEED_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 120_000;
const MAX_HISTORY_ROUNDS = 50;

let app;
let page;
let cdp;
let outDir;

function parseArgs(argv) {
    const options = { label: "run", seeds: 30, out: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg !== "--label" && arg !== "--seeds" && arg !== "--out") throw new Error(`Unknown flag ${arg}.`);
        const value = argv[index + 1];
        if (value === undefined) throw new Error(`${arg} needs a value.`);
        index += 1;
        if (arg === "--label") {
            options.label = value;
        } else if (arg === "--seeds") {
            options.seeds = Number(value);
            if (!Number.isInteger(options.seeds) || options.seeds < 1) throw new Error("--seeds needs a whole number, 1 or more.");
        } else {
            options.out = resolve(value);
        }
    }
    return options;
}

function log(text) {
    console.log(`[bench ${new Date().toISOString().slice(11, 19)}] ${text}`);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(check, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await check().catch(() => false)) return true;
        await pause(100);
    }
    return false;
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function childPids(pid) {
    try {
        return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

function commandOf(pid) {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

// Maps Electron pids to roles; the role names match the ones footprint and CPU figures are reported under.
function electronRoles() {
    const map = { [app.process().pid]: "electron-main" };
    for (const pid of childPids(app.process().pid)) {
        const command = commandOf(pid);
        const type = command.match(/--type=([a-z-]+)/)?.[1] ?? "child";
        const sub = command.match(/--utility-sub-type=([A-Za-z.]+)/)?.[1];
        map[pid] = sub ? `utility:${sub.split(".")[0]}` : type;
    }
    return map;
}

// ps prints [[dd-]hh:]mm:ss.ss on macOS; the fields are read from the right so a missing hour never shifts minutes.
function parseCpuTime(text) {
    let rest = text.trim();
    let days = 0;
    if (rest.includes("-")) {
        const [dayPart, timePart] = rest.split("-");
        days = Number(dayPart);
        rest = timePart;
    }
    const parts = rest.split(":").map(Number);
    const seconds = parts.at(-1) ?? 0;
    const minutes = parts.length >= 2 ? parts.at(-2) : 0;
    const hours = parts.length >= 3 ? parts.at(-3) : 0;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function cpuSeconds(pid) {
    const text = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" });
    return parseCpuTime(text);
}

async function snapshot() {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const values = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
    const commits = await page.evaluate(() => window.__benchCommits);
    const cpu = {};
    for (const [pid, role] of Object.entries(electronRoles())) {
        if (!CPU_ROLES.includes(role)) continue;
        cpu[role] = (cpu[role] ?? 0) + cpuSeconds(Number(pid));
    }
    return { at: Date.now(), metrics: values, commits, cpu };
}

function diff(before, after) {
    const delta = (name) => after.metrics[name] - before.metrics[name];
    const cpuMs = {};
    for (const role of CPU_ROLES) {
        cpuMs[role] = round1(((after.cpu[role] ?? 0) - (before.cpu[role] ?? 0)) * 1000);
    }
    return {
        wallMs: after.at - before.at,
        commits: after.commits - before.commits,
        taskMs: round1(delta("TaskDuration") * 1000),
        scriptMs: round1(delta("ScriptDuration") * 1000),
        layoutMs: round1(delta("LayoutDuration") * 1000),
        recalcStyleMs: round1(delta("RecalcStyleDuration") * 1000),
        layoutCount: delta("LayoutCount"),
        recalcStyleCount: delta("RecalcStyleCount"),
        cpuMs,
    };
}

// footprint -j exits non-zero when one pid vanished; the JSON still holds the rest.
function footprints(file) {
    const roles = electronRoles();
    try {
        execFileSync("footprint", ["-j", file, ...Object.keys(roles)], { stdio: "ignore" });
    } catch {
        // Handled by the parse below.
    }
    const data = JSON.parse(readFileSync(file, "utf8"));
    const totals = {};
    for (const entry of data.processes ?? []) {
        const role = roles[entry.pid];
        if (role === undefined) continue;
        totals[role] = (totals[role] ?? 0) + entry.footprint * data["bytes per unit"] / 1048576;
    }
    const result = {};
    for (const role of MEMORY_ROLES) {
        result[role] = totals[role] === undefined ? null : round1(totals[role]);
    }
    result.total = round1(Object.values(totals).reduce((sum, value) => sum + value, 0));
    return result;
}

async function measureMemory(name) {
    await cdp.send("HeapProfiler.collectGarbage");
    return footprints(join(outDir, `footprint-${name}.json`));
}

const sendMode = () => page.locator(".send-button").getAttribute("data-mode");

async function sendText(text) {
    const input = page.locator(".composer-input");
    await input.fill(text);
    await input.press("Enter");
    // The composer empties once the message is accepted; a message that stays put never sent.
    if (!await poll(async () => (await input.inputValue()) === "", 5_000)) {
        throw new Error(`The message "${text}" was not accepted by the composer.`);
    }
}

async function waitForTurnEnd(label, timeout) {
    await poll(async () => (await sendMode()) === "stop", 5_000);
    if (!await poll(async () => (await sendMode()) === "send", timeout)) {
        throw new Error(`The turn for "${label}" did not end within ${timeout / 1000} s.`);
    }
}

async function loadOlderHistory() {
    let rounds = 0;
    for (; rounds < MAX_HISTORY_ROUNDS; rounds += 1) {
        const strip = page.locator("button.trim-strip");
        if (await strip.count() === 0 || !await strip.first().isEnabled()) break;
        await strip.first().click();
        await pause(200);
        const settled = await poll(async () => await strip.count() === 0 || await strip.first().isEnabled(), 30_000);
        if (!settled) throw new Error("Loading earlier messages did not finish within 30 s.");
    }
    return rounds;
}

async function scrollToBottom() {
    await page.evaluate(() => {
        const scroller = document.querySelector(".transcript-scroll");
        scroller.scrollTop = scroller.scrollHeight;
    });
}

async function scrollToTopInSteps() {
    await page.evaluate(async () => {
        const scroller = document.querySelector(".transcript-scroll");
        for (let step = 0; step < 10_000 && scroller.scrollTop > 0; step += 1) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop - 400);
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    });
}

async function setWindowShown(shown) {
    await app.evaluate(({ BrowserWindow }, visible) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (visible) window.showInactive();
        else window.hide();
    }, shown);
}

const pageState = async () => ({ ...(await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }))), shown: await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w.isVisible() && !w.isMinimized(); }) });

async function runStreamPhase(label, text, { background }) {
    if (background) await setWindowShown(false);
    const before = await snapshot();
    await sendText(text);
    const start = await pageState();
    await waitForTurnEnd(text, STREAM_TIMEOUT_MS);
    await pause(1000);
    const end = await pageState();
    const after = await snapshot();
    if (background) {
        await setWindowShown(true);
        await pause(2000);
    }
    log(`${label}: focused ${start.focused}/${end.focused}, visibility ${start.visibility}/${end.visibility}, shown ${start.shown}/${end.shown}`);
    return { label, page: { start, end }, ...diff(before, after) };
}

function phaseRows(results) {
    const header = ["phase", "wall ms", "commits", "task ms", "script ms", "layout ms", "style ms", "layouts", "styles", "renderer cpu", "gpu cpu", "main cpu"];
    const rows = [header];
    for (const phase of results) {
        rows.push([
            phase.name,
            String(phase.wallMs),
            String(phase.commits),
            String(phase.taskMs),
            String(phase.scriptMs),
            String(phase.layoutMs),
            String(phase.recalcStyleMs),
            String(phase.layoutCount),
            String(phase.recalcStyleCount),
            String(phase.cpuMs.renderer),
            String(phase.cpuMs["gpu-process"]),
            String(phase.cpuMs["electron-main"]),
        ]);
    }
    return rows;
}

function formatRows(rows) {
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
    return rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")).join("\n");
}

function printReport(results) {
    const memoryHeader = ["memory MB", ...MEMORY_ROLES, "total"];
    const memoryRow = (name, memory) => [name, ...MEMORY_ROLES.map((role) => String(memory[role] ?? "n/a")), String(memory.total)];
    const memoryRows = [memoryHeader, memoryRow("top", results.memory.top), memoryRow("bottom idle", results.memory.bottomIdle)];
    console.log(`label ${results.label}  commit ${results.commit}${results.dirty ? " (dirty)" : ""}  seeds ${results.seeds}  assistant entries ${results.assistantEntries}  DOM nodes ${results.domNodes}`);
    console.log(formatRows(phaseRows(results.tablePhases)));
    console.log("");
    console.log(formatRows(memoryRows));
}

async function main(options, trial, provider) {
    const trialRoot = dirname(trial.home);
    const folder = join(trialRoot, "bench-yard");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "README.md"), "# Bench yard\n\nA folder the benchmark session works in.\n");
    configureFauxHome(trial.home, provider.port, "auto");

    app = await trial.launch({ visible: true });
    page = await app.firstWindow();
    await page.waitForSelector(".app", { timeout: 45_000 });
    await app.evaluate(({ dialog, BrowserWindow }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
        const window = BrowserWindow.getAllWindows()[0];
        window.setBounds({ x: 80, y: 60, width: 1440, height: 900 });
        // Desk clicks and keys would otherwise land in the window while it runs.
        window.setIgnoreMouseEvents(true);
        window.setFocusable(false);
        window.showInactive();
    }, folder);
    await trial.waitForHost();

    const home = page.locator("text=Where to, captain?");
    if (!await home.isVisible().catch(() => false)) {
        await page.getByText("New Chat", { exact: true }).first().click();
    }
    await home.waitFor({ timeout: 10_000 });
    await page.locator(".context-chips button").first().click();
    await pause(500);
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"bench-yard\")", { timeout: 10_000 });
    await pause(500);
    log("session ready in bench-yard");

    for (let i = 1; i <= options.seeds; i += 1) {
        await sendText(`SEED ${i}`);
        await waitForTurnEnd(`SEED ${i}`, SEED_TIMEOUT_MS);
    }
    log(`seeded ${options.seeds} turns`);

    const rounds = await loadOlderHistory();
    log(`loaded older history in ${rounds} rounds`);
    await scrollToBottom();
    await pause(2000);

    const assistantEntries = await page.locator(".assistant-text").count();
    const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);

    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.evaluate(() => {
        if (window.__benchCommits !== undefined) return;
        window.__benchCommits = 0;
        const scroller = document.querySelector(".transcript-scroll");
        if (scroller === null) throw new Error("The transcript scroller is missing.");
        new MutationObserver(() => { window.__benchCommits += 1; })
            .observe(scroller, { subtree: true, childList: true, characterData: true, attributes: true });
    });

    const phases = {};
    const visible = await runStreamPhase("stream-visible", "STREAM visible", { background: false });
    phases["stream-visible"] = visible;
    log("stream-visible done");

    const background = await runStreamPhase("stream-background", "STREAM background", { background: true });
    phases["stream-background"] = background;
    log("stream-background done");

    await scrollToBottom();
    await pause(500);
    const scrollBefore = await snapshot();
    await scrollToTopInSteps();
    await pause(1000);
    const scrollAfter = await snapshot();
    phases["scroll-up"] = { label: "scroll-up", ...diff(scrollBefore, scrollAfter) };
    log("scroll-up done");

    const top = await measureMemory("top");
    await scrollToBottom();
    await pause(5000);
    const bottomIdle = await measureMemory("bottom-idle");
    log("memory done");

    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
    const results = {
        label: options.label,
        commit,
        dirty,
        seeds: options.seeds,
        assistantEntries,
        domNodes,
        phases,
        memory: { top, bottomIdle },
    };
    writeFileSync(join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    printReport({
        ...results,
        tablePhases: Object.entries(phases).map(([name, phase]) => ({ name, ...phase })),
    });
    console.log(`out dir: ${outDir}`);
}

async function run() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    outDir = options.out ?? join(tmpdir(), `vera-desktop-bench-${new Date().toISOString().replace(/[:.]/g, "-")}`);

    const trial = startTrial();
    const trialRoot = dirname(trial.home);
    let provider;
    let cleanupRun;
    const cleanup = () => {
        cleanupRun ??= (async () => {
            await trial.cleanup().catch((error) => console.error(`Cleanup: ${error.message}`));
            await provider?.close();
        })();
        return cleanupRun;
    };
    process.once("SIGINT", () => {
        console.error("\nInterrupted, cleaning up.");
        cleanup().finally(() => process.exit(130));
    });

    let exitCode = 0;
    try {
        if (outDir === trialRoot || outDir.startsWith(trialRoot + sep)) {
            console.error("--out must be outside the trial root, which is deleted at the end.");
            return 2;
        }
        mkdirSync(outDir, { recursive: true });
        provider = await startBenchProvider();
        await main(options, trial, provider);
    } catch (error) {
        console.error(error);
        exitCode = 1;
    } finally {
        await cleanup();
    }
    return exitCode;
}

run().then((code) => process.exit(code));
