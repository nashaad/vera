// App shell test for the desktop. Run with: node clients/desktop/test/shell.e2e.mjs
// Builds the desktop package and the app shell, unpacks the shell, and starts its app folder against a prefix
// that holds a fixture host release. With no package installed the shell shows its notice; with the package
// installed it loads the package's window and records that it holds the package.
// The app folder runs under the stock Electron binary: a packaged executable ignores the -r that keeps trial windows out of sight.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const HOST_BUILD = "vera-shell-e2e";
const trial = startTrial();
const bun = process.env.VERA_DESKTOP_BUN || execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
let failed = false;

try {
    const arch = process.arch;
    const out = join(trial.trialRoot, "release");
    execFileSync(bun, ["run", join(trial.root, "scripts", "build-desktop-release.ts"), "--build-id", HOST_BUILD, "--arch", arch, "--out", out], { stdio: "inherit" });
    const packageArchive = join(out, `vera-desktop-darwin-${arch}.tar.gz`);
    const shellArchive = join(out, `vera-desktop-shell-darwin-${arch}.tar.gz`);
    const sha = (archive) => readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/)[0];
    const desktopVersion = JSON.parse(execFileSync("tar", ["-xzOf", packageArchive, "desktop-package.json"], { encoding: "utf8" })).desktop_version;

    // The shell follows VERA_DESKTOP_LAUNCHER into a prefix of its own; HOME stays the real one.
    const prefix = join(trial.trialRoot, "prefix");
    const share = join(prefix, "share", "vera");
    mkdirSync(join(share, "releases", HOST_BUILD), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(share, "releases", HOST_BUILD, "vera"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    symlinkSync(join("releases", HOST_BUILD), join(share, "current"));
    symlinkSync(join(share, "current", "vera"), join(prefix, "bin", "vera"));

    const applications = join(trial.trialRoot, "Applications");
    mkdirSync(applications);
    execFileSync("tar", ["-xzf", shellArchive, "-C", applications]);
    const appDir = join(applications, "Vera.app", "Contents", "Resources", "app");
    const env = {
        VERA_DESKTOP_LAUNCHER: join(prefix, "bin", "vera"),
        VERA_DESKTOP_DEV_CLI: join(trial.root, "clients", "cli", "main.ts"),
    };
    // A mock keychain keeps the app from opening the login keychain.
    const args = ["--use-mock-keychain"];
    const loaded = join(share, "desktop", ".loaded");

    // No package for the current host build: one plain window says so, and nothing is held.
    const bare = await trial.launch({ appDir, env, args });
    const notice = await bare.firstWindow();
    await until("the notice text", async () => (await notice.locator("body").innerText()).includes(`The Vera desktop app for build ${HOST_BUILD} is not installed.`));
    const noticeText = await notice.locator("body").innerText();
    if (!noticeText.includes("Run the Vera installer again")) throw new Error(`The notice does not point at the installer: ${noticeText}`);
    if (await bare.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) !== 1) throw new Error("The notice is not one window.");
    if (existsSync(loaded)) throw new Error("The shell held a package it did not load.");
    await bare.close();

    // With the package installed, the shell loads it from the package folder and holds it.
    execFileSync(bun, ["--eval", `
        import { installDesktopPackage } from ${JSON.stringify(join(trial.root, "src", "release", "desktop-packages.ts"))};
        const [tarball, sha256, hostBuildId, desktopVersion, prefix] = process.argv.slice(1);
        const result = await installDesktopPackage({ tarball, sha256, hostBuildId, desktopVersion, prefix });
        if (!result.installed) throw new Error("The package was not installed.");
    `, packageArchive, sha(packageArchive), HOST_BUILD, desktopVersion, prefix], { stdio: "inherit" });

    const app = await trial.launch({ appDir, env, args });
    const page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();
    const packageDirectory = realpathSync(join(share, "desktop", HOST_BUILD, desktopVersion));
    const url = decodeURIComponent(page.url());
    if (!url.startsWith(`file://${packageDirectory}/renderer/`)) throw new Error(`The window loaded ${url}, not the package at ${packageDirectory}.`);
    const bridge = await page.evaluate(() => typeof window.veraDesktop);
    if (bridge !== "object") throw new Error(`The package's preload did not run (veraDesktop is ${bridge}).`);
    const record = JSON.parse(readFileSync(join(loaded, `${app.process().pid}.json`), "utf8"));
    if (record.host_build_id !== HOST_BUILD || record.desktop_version !== desktopVersion) throw new Error(`The hold record is wrong: ${JSON.stringify(record)}`);
    console.log(`shell loaded ${url} and holds ${HOST_BUILD}/${desktopVersion}`);
    await app.close();
    await until("the hold released", async () => !existsSync(join(loaded, `${record.pid}.json`)), 10_000);
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    await trial.cleanup();
}
process.exit(failed ? 1 : 0);
