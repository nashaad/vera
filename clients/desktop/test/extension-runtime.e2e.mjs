// Desktop extension runtime test. Run with: node clients/desktop/test/extension-runtime.e2e.mjs
// Folders under the trial home's extensions directory stand in for installed extensions.

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { markDesktopExtensionStoreMigrated } from "./extension-fixtures.mjs";
import { until } from "./faux-home.mjs";
import { closeApp, MODIFIER, press, startTrial } from "./trial.mjs";

const checkProcess = process.kill.bind(process);
process.kill = (pid, signal = "SIGTERM") => {
    if (signal !== 0) throw new Error(`Refusing to signal process ${pid}.`);
    return checkProcess(pid, signal);
};

const trial = startTrial();
const extensions = join(trial.home, "machine", "desktop", "extensions");
const logs = join(trial.home, "machine", "desktop", "logs");
let page;
let failed = false;

function manifest(id, commands, extra = {}) {
    return { id, version: "1.0.0", engine: "vera-gui@^1", main: "main.js", contributes: { commands }, ...extra };
}

function write(folder, name, value) {
    const directory = join(extensions, folder);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), typeof value === "string" ? value : JSON.stringify(value));
    return directory;
}

const DEMO = `
export function activate(vera) {
    vera.commands.register("demo.hello", () => {
        vera.window.showToast("hello from demo", "success");
        vera.output.appendLine("hello ran");
    });
    vera.commands.register("demo.arm", () => vera.context.set("demo.armed", true));
    vera.commands.register("demo.disarm", () => vera.context.set("demo.armed"));
    vera.commands.register("demo.armedOnly", () => vera.window.showToast("armed", "info"));
    vera.commands.register("demo.fail", () => { throw new Error("boom"); });
    const refusals = [];
    try { vera.commands.register("demo.undeclared", () => {}); } catch (error) { refusals.push("command"); }
    try { vera.context.set("other.key", true); } catch (error) { refusals.push("context"); }
    const sealed = { document: typeof document, window: typeof window, require: typeof require, process: typeof process, bridge: typeof veraDesktop };
    fetch("http://127.0.0.1:9/").then(() => { sealed.fetch = "allowed"; }, () => { sealed.fetch = "blocked"; })
        .then(() => vera.output.appendLine("sealed " + JSON.stringify(sealed) + " refused " + refusals.join(",")));
}
`;

const SPINNER = `
export function activate(vera) {
    vera.commands.register("spinner.hang", () => { for (;;) {} });
    vera.commands.register("spinner.after", () => vera.window.showToast("back", "info"));
}
`;

function prepare() {
    markDesktopExtensionStoreMigrated(trial.home);
    const demoCommands = [
        { command: "demo.hello", title: "Say Hello", category: "Demo" },
        { command: "demo.arm", title: "Arm", category: "Demo" },
        { command: "demo.disarm", title: "Disarm", category: "Demo" },
        { command: "demo.armedOnly", title: "Armed Only", category: "Demo", when: "demo.armed" },
        { command: "demo.fail", title: "Fail", category: "Demo" },
    ];
    const mac = process.platform === "darwin";
    write("demo", "vera.desktop.json", manifest("demo", demoCommands, {
        contributes: {
            commands: demoCommands,
            keybindings: [{ command: "demo.hello", key: "ctrl+shift+y", mac: "cmd+shift+y" }],
        },
    }));
    write("demo", "main.js", DEMO);
    write("spinner", "vera.desktop.json", manifest("spinner", [
        { command: "spinner.hang", title: "Hang", category: "Spinner" },
        { command: "spinner.after", title: "After", category: "Spinner" },
    ]));
    write("spinner", "main.js", SPINNER);

    write("broken-json", "vera.desktop.json", "{ \"id\": ");
    write("bad-when", "vera.desktop.json", manifest("bad-when", [
        { command: "bad-when.run", title: "Run", when: "view == 'x' && nothing" },
    ]));
    write("go", "vera.desktop.json", manifest("go", [{ command: "go.settings", title: "Replace Settings" }]));
    write("go", "main.js", "export function activate() {}");
    write("misnamed", "vera.desktop.json", manifest("other-name", []));

    const escape = write("escape", "vera.desktop.json", manifest("escape", [{ command: "escape.run", title: "Escape Test" }]));
    writeFileSync(join(trial.trialRoot, "outside.js"), "export function activate() {}");
    symlinkSync(join(trial.trialRoot, "outside.js"), join(escape, "main.js"));

    write("large", "vera.desktop.json", manifest("large", [{ command: "large.run", title: "Large Test" }]));
    write("large", "main.js", `export function activate() {}\n// ${"x".repeat(1024 * 1024)}`);
    return mac;
}

function metrics(app) {
    return app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        name: metric.name ?? "",
        kb: metric.memory.workingSetSize,
    })));
}

function summary(label, list) {
    const tabs = list.filter((metric) => metric.type === "Tab");
    const total = list.reduce((sum, metric) => sum + metric.kb, 0);
    console.log(`${label}: ${list.length} processes, ${tabs.length} renderer, ${Math.round(total / 1024)} MB working set (${list.map((metric) => `${metric.type}:${metric.pid}:${Math.round(metric.kb / 1024)}`).join(" ")})`);
    return { tabs: tabs.length, total, list };
}

function states() {
    return page.evaluate(() => Object.fromEntries(window.__veraExtensions.states().map((entry) => [entry.extensionId, entry.state])));
}

function failures() {
    return page.evaluate(() => Object.fromEntries(window.__veraExtensions.failures().map((entry) => [entry.extensionId, entry.reason])));
}

function frames() {
    return page.locator('iframe[sandbox="allow-scripts"][aria-hidden="true"]').count();
}

function expect(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
}

function expectMatch(actual, pattern, label) {
    if (!pattern.test(actual ?? "")) throw new Error(`${label}: ${JSON.stringify(actual)} does not match ${pattern}.`);
}

async function openPalette(app, query) {
    await press(app, "K", [MODIFIER]);
    const input = page.locator("input[aria-label=\"Command palette\"]");
    await input.waitFor({ timeout: 10_000 });
    await input.fill(query);
    return input;
}

async function closePalette() {
    await page.keyboard.press("Escape");
    await page.locator("input[aria-label=\"Command palette\"]").waitFor({ state: "detached", timeout: 10_000 });
}

function row(id) {
    return page.locator(`.palette-row[data-command="${id}"]`);
}

async function runFromPalette(app, id, query) {
    const input = await openPalette(app, query);
    await row(id).waitFor({ timeout: 10_000 });
    await input.press("Enter");
}

function toast(text) {
    return page.locator(".toast", { hasText: text }).first();
}

function log(id) {
    try {
        return readFileSync(join(logs, `${id}.log`), "utf8");
    } catch {
        return "";
    }
}

try {
    const mac = prepare();
    const app = await trial.launch({ args: ["-r", join(trial.root, "clients", "desktop", "test", "no-task-process.cjs")] });
    page = await app.firstWindow();
    page.on("pageerror", (error) => console.error("page error:", error.message));
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
    await page.evaluate(() => window.localStorage.setItem("veraExtensionsTest", "1"));
    await page.reload();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await until("the extensions to load", () => page.evaluate(() => window.__veraExtensions?.states().length > 0));

    // Nothing runs at launch: the extensions are listed and drawn, and there is no frame.
    expect(await frames(), 0, "frames at launch");
    const before = summary("at launch", await metrics(app));
    const initial = await states();
    expect(initial.demo, "inactive", "demo state at launch");
    expect(initial.spinner, "inactive", "spinner state at launch");

    // Manifests that do not load are listed with a reason and draw nothing.
    const reasons = await failures();
    expectMatch(reasons["broken-json"], /not valid JSON/, "broken-json");
    expectMatch(reasons["bad-when"], /bad-when\.run|nothing/, "bad-when");
    expectMatch(reasons.go, /core command/, "go");
    expectMatch(reasons.misnamed, /folder name/, "misnamed");

    const input = await openPalette(app, "Demo");
    await row("demo.hello").waitFor({ timeout: 10_000 });
    expect(await row("demo.armedOnly").count(), 0, "a command whose when does not hold");
    expect(await row("bad-when.run").count(), 0, "a command of a failed manifest");
    await input.fill("Replace");
    expect(await row("go.settings").count(), 0, "the conflicting extension's command");
    await closePalette();
    expect(await frames(), 0, "frames after the palette opened");

    // The first run of a command starts the worker; the extension's handles reach the window.
    await runFromPalette(app, "demo.hello", "Say Hello");
    await toast("demo: hello from demo").waitFor({ timeout: 15_000 });
    expect(await frames(), 1, "frames with one active extension");
    expect((await states()).demo, "active", "demo state after a run");
    await until("the extension log", () => /hello ran/.test(log("demo")));
    const sealed = /sealed (\{.*\}) refused (.*)/.exec(log("demo"));
    if (sealed === null) throw new Error(`The sandbox report is missing from the log:\n${log("demo")}`);
    const report = JSON.parse(sealed[1]);
    for (const name of ["document", "window", "require", "process", "bridge"]) expect(report[name], "undefined", `${name} in the worker`);
    expect(report.fetch, "blocked", "network from the worker");
    expect(sealed[2].trim(), "command,context", "refusals in the worker");
    const active = summary("one active worker", await metrics(app));

    // The bound key runs the same command.
    await toast("demo: hello from demo").waitFor({ state: "detached", timeout: 15_000 });
    await press(app, "Y", mac ? ["meta", "shift"] : ["control", "shift"]);
    await toast("demo: hello from demo").waitFor({ timeout: 15_000 });

    // A context key set by the extension shows the command whose when clause names it, and clearing hides it.
    await runFromPalette(app, "demo.arm", "Arm");
    await until("the key to show the command", async () => {
        await openPalette(app, "Armed Only");
        const shown = (await row("demo.armedOnly").count()) === 1;
        await closePalette();
        return shown;
    });
    await runFromPalette(app, "demo.disarm", "Disarm");
    await until("the key to hide the command", async () => {
        await openPalette(app, "Armed Only");
        const hidden = (await row("demo.armedOnly").count()) === 0;
        await closePalette();
        return hidden;
    });

    // A throwing handler fails its command, not the extension.
    await runFromPalette(app, "demo.fail", "Demo: Fail");
    await toast("Command demo.fail failed: boom").waitFor({ timeout: 15_000 });
    expect((await states()).demo, "active", "demo state after a failed command");

    // An extension whose file leaves its folder or is too large does not start, and no frame is left behind.
    await runFromPalette(app, "escape.run", "Escape Test");
    await toast("Extension escape could not start").waitFor({ timeout: 15_000 });
    await runFromPalette(app, "large.run", "Large Test");
    await toast("Extension large could not start").waitFor({ timeout: 15_000 });
    const refused = await states();
    expect(refused.escape, "failed", "escape state");
    expect(refused.large, "failed", "large state");
    expect(await frames(), 1, "frames after refused starts");

    // A hung extension is stopped while the window stays usable.
    await runFromPalette(app, "spinner.hang", "Hang");
    await until("a second frame", async () => (await frames()) === 2);
    const twoExtensions = summary("two active extensions", await metrics(app));
    expect(twoExtensions.tabs, before.tabs + 1, "renderer count with two active extensions");
    await until("the spinner to be marked not responding", async () => (await states()).spinner === "not-responding", 20_000);
    expect(await frames(), 1, "frames after the hung worker was stopped");
    await until("the spinner's log line", () => /did not answer a ping in time/.test(log("spinner")));
    await openPalette(app, "After");
    await row("spinner.after").waitFor({ timeout: 10_000 });
    await row("spinner.after").click();
    await toast("spinner: back").waitFor({ timeout: 15_000 });
    expect((await states()).spinner, "active", "spinner state after a fresh start");
    expect(await frames(), 2, "frames after the restart");

    // Stopping ends the worker and removes its frame and its extra process.
    await page.evaluate(() => { window.__veraExtensions.stop("spinner"); window.__veraExtensions.stop("demo"); });
    expect(await frames(), 0, "frames after stop");
    expect((await states()).demo, "inactive", "demo state after stop");
    let after;
    await until("the extra renderer to exit", async () => {
        after = await metrics(app);
        return after.filter((metric) => metric.type === "Tab").length === before.tabs;
    }, 15_000);
    summary("after stop", after);

    // The next run starts a fresh worker.
    await runFromPalette(app, "demo.hello", "Say Hello");
    await toast("demo: hello from demo").waitFor({ timeout: 15_000 });
    expect(await frames(), 1, "frames after a run following stop");

    // Closing the window ends every worker, so no process of the run outlives it.
    const pids = (await metrics(app)).map((metric) => metric.pid);
    await closeApp(app);
    await until("every process to exit", () => pids.every((pid) => {
        try {
            process.kill(pid, 0);
            return false;
        } catch {
            return true;
        }
    }), 20_000);
    console.log(`memory: launch ${Math.round(before.total / 1024)} MB, one worker ${Math.round(active.total / 1024)} MB`);
    console.log("extensions e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
    for (const id of ["demo", "spinner"]) console.error(`${id} log:`, log(id));
} finally {
    await trial.cleanup();
}
process.exit(failed ? 1 : 0);
