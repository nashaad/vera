// Relaunch test for the desktop. Run with: node clients/desktop/test/relaunch.e2e.mjs
// Two desktop packages for two host builds sit in a temp prefix. The app shell starts on the first, `current` moves
// to the second, and Reconnect makes the window relaunch itself: the new process loads the second package, the
// first process drops its hold, and the new window reopens the session the first one showed.
// Then a newer package for the second build is installed, as install:local --desktop-only does, and the window
// relaunches into it with no reconnect, reopening the same session.
// The app folder runs under the stock Electron binary: a packaged executable ignores the -r that keeps trial windows out of sight.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const FIRST = "vera-relaunch-e2e-a";
const SECOND = "vera-relaunch-e2e-b";
const REPLY = "The crow settles on the branch.";

const root = new URL("../../..", import.meta.url).pathname;
const { chromium } = createRequire(join(root, "clients", "desktop", "package.json"))("playwright-core");

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
                choices: [{ index: 0, message: { role: "assistant", content: "Crow notes" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of REPLY.split(/(?= )/)) response.write(streamChunk(body.model, { content: part }));
        response.write(streamChunk(body.model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

async function freePort() {
    const probe = createPortProbe();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const trial = startTrial();
const bun = process.env.VERA_DESKTOP_BUN || execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
let failed = false;
let relaunchedPid;
let attached;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const arch = process.arch;

    const archives = {};
    for (const build of [FIRST, SECOND]) {
        const out = join(trial.trialRoot, `release-${build}`);
        execFileSync(bun, ["run", join(root, "scripts", "build-desktop-release.ts"), "--build-id", build, "--arch", arch, "--out", out], { stdio: "inherit" });
        archives[build] = { directory: out, package: join(out, `vera-desktop-darwin-${arch}.tar.gz`) };
    }
    const sha = (archive) => readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/)[0];
    const desktopVersion = JSON.parse(execFileSync("tar", ["-xzOf", archives[FIRST].package, "desktop-package.json"], { encoding: "utf8" })).desktop_version;
    const newerVersion = execFileSync(bun, ["--eval", `
        import { nextLocalDesktopVersion } from ${JSON.stringify(join(root, "scripts", "install-local-desktop-only.ts"))};
        console.log(nextLocalDesktopVersion(process.argv[1]));
    `, desktopVersion], { encoding: "utf8" }).trim();
    const newerOut = join(trial.trialRoot, "release-newer");
    execFileSync(bun, ["run", join(root, "scripts", "build-desktop-release.ts"), "--build-id", SECOND, "--arch", arch, "--desktop-version", newerVersion, "--out", newerOut], { stdio: "inherit" });
    const newerPackage = join(newerOut, `vera-desktop-darwin-${arch}.tar.gz`);

    // The shell follows VERA_DESKTOP_LAUNCHER into a prefix of its own; HOME stays the real one.
    const prefix = join(trial.trialRoot, "prefix");
    const share = join(prefix, "share", "vera");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    for (const build of [FIRST, SECOND]) {
        mkdirSync(join(share, "releases", build), { recursive: true });
        writeFileSync(join(share, "releases", build, "vera"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    symlinkSync(join("releases", FIRST), join(share, "current"));
    symlinkSync(join(share, "current", "vera"), join(prefix, "bin", "vera"));
    const installPackage = (tarball, build, version) => execFileSync(bun, ["--eval", `
        import { installDesktopPackage } from ${JSON.stringify(join(root, "src", "release", "desktop-packages.ts"))};
        const [tarball, sha256, hostBuildId, desktopVersion, prefix] = process.argv.slice(1);
        const result = await installDesktopPackage({ tarball, sha256, hostBuildId, desktopVersion, prefix });
        if (!result.installed) throw new Error("The package was not installed.");
    `, tarball, sha(tarball), build, version, prefix], { stdio: "inherit" });
    for (const build of [FIRST, SECOND]) installPackage(archives[build].package, build, desktopVersion);

    const applications = join(trial.trialRoot, "Applications");
    mkdirSync(applications);
    execFileSync("tar", ["-xzf", join(archives[FIRST].directory, `vera-desktop-shell-darwin-${arch}.tar.gz`), "-C", applications]);
    const appDir = join(applications, "Vera.app", "Contents", "Resources", "app");
    const env = { VERA_DESKTOP_LAUNCHER: join(prefix, "bin", "vera") };
    // A fixed debugging port is repeated by the relaunch, which is how the test reaches the new process.
    const port = await freePort();
    const args = ["--use-mock-keychain", `--remote-debugging-port=${port}`];
    const loaded = join(share, "desktop", ".loaded");
    const packageUrl = (build, version = desktopVersion) => `file://${realpathSync(join(share, "desktop", build, version))}/renderer/`;

    const folder = join(trial.home, "..", "nest");
    mkdirSync(folder, { recursive: true });
    const app = await trial.launch({ appDir, env, args });
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    const page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();
    if (!decodeURIComponent(page.url()).startsWith(packageUrl(FIRST))) throw new Error(`The first window loaded ${page.url()}, not the package for ${FIRST}.`);
    const firstPid = app.process().pid;
    if (JSON.parse(readFileSync(join(loaded, `${firstPid}.json`), "utf8")).host_build_id !== FIRST) throw new Error("The first process does not hold the first package.");

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"nest\")");
    const input = page.locator(".composer-input");
    await input.fill("Tell me about crows");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 45_000 });
    const agentId = await page.locator("[data-session][data-phase]").first().getAttribute("data-session");
    // The page reports the shown session to the shell over a one-way message; give it a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The installer moved `current` to the second build while the window was open.
    const staged = join(share, "current.next");
    symlinkSync(join("releases", SECOND), staged);
    renameSync(staged, join(share, "current"));
    await page.evaluate(() => window.veraDesktop.reconnect());

    await until("the first process to exit", () => !alive(firstPid), 30_000);
    if (existsSync(join(loaded, `${firstPid}.json`))) throw new Error("The first process kept its hold on the first package.");
    relaunchedPid = await relaunchedHolding(loaded, firstPid, SECOND, desktopVersion);

    // The relaunched window runs the second package and shows the session the first one had open.
    const reopened = await windowFor(port, packageUrl(SECOND));
    await reopened.waitForSelector(`[data-session="${agentId}"][data-phase="attached"]`, { timeout: 60_000 });
    await reopened.waitForSelector(`text=${REPLY}`, { timeout: 45_000 });
    if (await reopened.locator("text=Vera was updated").count() !== 0) throw new Error("The relaunched window shows the update banner.");
    console.log(`relaunched pid ${firstPid} -> ${relaunchedPid}: loaded ${SECOND}, reopened session ${agentId}`);

    // A newer package for the build the window runs relaunches it with no reconnect.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const secondPid = relaunchedPid;
    installPackage(newerPackage, SECOND, newerVersion);
    await until("the second process to exit", () => !alive(secondPid), 30_000);
    await attached?.close().catch(() => {});
    attached = undefined;
    relaunchedPid = await relaunchedHolding(loaded, secondPid, SECOND, newerVersion);
    const reloaded = await windowFor(port, packageUrl(SECOND, newerVersion));
    await reloaded.waitForSelector(`[data-session="${agentId}"][data-phase="attached"]`, { timeout: 60_000 });
    await reloaded.waitForSelector(`text=${REPLY}`, { timeout: 45_000 });
    console.log(`reloaded pid ${secondPid} -> ${relaunchedPid}: loaded ${SECOND} ${newerVersion}, reopened session ${agentId}`);
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    await stopRelaunched();
    await trial.cleanup();
}
process.exit(failed ? 1 : 0);

async function relaunchedHolding(loaded, previousPid, build, version) {
    let pid;
    await until(`a relaunched process to hold ${build} ${version}`, () => {
        if (!existsSync(loaded)) return false;
        for (const name of readdirSync(loaded)) {
            const record = JSON.parse(readFileSync(join(loaded, name), "utf8"));
            if (record.pid !== previousPid && alive(record.pid) && record.host_build_id === build && record.desktop_version === version) {
                pid = record.pid;
                return true;
            }
        }
        return false;
    }, 60_000);
    return pid;
}

async function windowFor(port, url) {
    let found;
    await until("the relaunched window to be reachable", async () => {
        try {
            attached ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
            found = attached.contexts().flatMap((context) => context.pages()).find((candidate) => decodeURIComponent(candidate.url()).startsWith(url));
            return found !== undefined;
        } catch {
            attached = undefined;
            return false;
        }
    }, 60_000);
    return found;
}

// The relaunched app is a process the test started through the first one; it is asked to close, then signalled by the pid it recorded.
async function stopRelaunched() {
    if (relaunchedPid === undefined) return;
    try {
        if (attached !== undefined) {
            const session = await attached.newBrowserCDPSession();
            await session.send("Browser.close").catch(() => {});
        }
    } catch {
        // The connection is gone with the process.
    }
    for (const signal of ["SIGTERM", "SIGKILL"]) {
        try {
            await until("the relaunched process to exit", () => !alive(relaunchedPid), 10_000);
            return;
        } catch {
            try {
                process.kill(relaunchedPid, signal);
            } catch {
                return;
            }
        }
    }
}
