import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { otherMacCommands } from "../../scripts/update-rehearsal.ts";

const script = resolve(import.meta.dir, "../../scripts/update-rehearsal.ts");

test("rehearsal feed controls stay in memory and serve bounded release assets and controlled faux replies", async () => {
    const out = mkdtempSync(join(tmpdir(), "vera-rehearsal-feed-"));
    for (const version of ["0.1.0-alpha.1", "0.1.0-alpha.2"]) {
        mkdirSync(join(out, `v${version}`));
        writeFileSync(join(out, `v${version}`, "vera-linux-arm64.tar.gz"), "x".repeat(256));
        writeFileSync(join(out, `v${version}`, "vera-linux-arm64.tar.gz.sha256"), "a".repeat(64));
    }
    const child = Bun.spawn([process.execPath, script, "serve", out, "--port", "0", "--only", "0.1.0-alpha.1"], {
        stdout: "pipe", stderr: "pipe",
    });
    try {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        const address = new TextDecoder().decode(first.value).trim().replace("Rehearsal feed: ", "");
        expect(address).toStartWith("http://127.0.0.1:");
        const releases = async () => await (await fetch(`${address}/releases`)).json() as Array<{ tag_name: string; body: string; draft: boolean }>;
        expect((await releases()).map((item) => item.tag_name)).toEqual(["v0.1.0-alpha.1"]);
        const asset = `${address}/v0.1.0-alpha.2/vera-linux-arm64.tar.gz`;
        expect((await (await fetch(asset)).text()).length).toBe(256);
        expect(await (await fetch(`${asset}.sha256`)).text()).toBe("a".repeat(64));
        const scenario = async (mode: string) => await fetch(`${address}/control/scenario?mode=${mode}&version=0.1.0-alpha.2`, { method: "POST" });
        expect((await scenario("wrong-checksum")).status).toBe(200);
        expect(await releases()).toEqual([
            { tag_name: "v0.1.0-alpha.2", body: "Update rehearsal release 0.1.0-alpha.2.", draft: false },
            { tag_name: "v0.1.0-alpha.1", body: "Update rehearsal release 0.1.0-alpha.1.", draft: false },
        ]);
        expect(await (await fetch(`${asset}.sha256`)).text()).toStartWith("0".repeat(64));
        expect((await scenario("truncated-tarball")).status).toBe(200);
        expect((await (await fetch(asset)).text()).length).toBe(128);
        expect(await (await fetch(`${asset}.sha256`)).text()).toBe("a".repeat(64));
        expect(await (await fetch(`${address}/control/counts`)).json()).toEqual({ downloads: 2, requests: 0, completed: 0, active: 0 });
        expect((await scenario("not-a-mode")).status).toBe(400);
        expect((await fetch(`${address}/v0.1.0-alpha.2/nope`)).status).toBe(404);
        expect(await (await fetch(`${address}/install.sh`)).text()).toContain("VERA_RELEASES_DOWNLOAD_BASE");
        const reply = fetch(`${address}/v1/chat/completions`, { method: "POST" });
        await Bun.sleep(100);
        expect((await scenario("normal")).status).toBe(409);
        expect((await fetch(`${address}/control/complete-turn`, { method: "POST" })).status).toBe(200);
        expect(await (await reply).text()).toContain("container faux passed");
        expect(await (await fetch(`${address}/control/counts`)).json()).toEqual({ downloads: 2, requests: 1, completed: 1, active: 0 });
    } finally {
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);
        rmSync(out, { recursive: true, force: true });
    }
}, 20_000);

test("rehearsal feed serves the desktop assets and hides them only for the target release in the no-desktop scenario", async () => {
    const out = mkdtempSync(join(tmpdir(), "vera-rehearsal-desktop-feed-"));
    const assets = ["vera-darwin-arm64.tar.gz", "vera-desktop-darwin-arm64.tar.gz", "vera-desktop-shell-darwin-arm64.tar.gz"];
    for (const version of ["0.0.9", "0.1.0"]) {
        mkdirSync(join(out, `v${version}`));
        for (const asset of assets) {
            writeFileSync(join(out, `v${version}`, asset), `${version} ${asset}`);
            writeFileSync(join(out, `v${version}`, `${asset}.sha256`), `${"a".repeat(64)}  ${asset}\n`);
        }
    }
    const child = Bun.spawn([process.execPath, script, "serve", out, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
    try {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        const address = new TextDecoder().decode(first.value).trim().replace("Rehearsal feed: ", "");
        const status = async (version: string, asset: string, suffix = "") => (await fetch(`${address}/v${version}/${asset}${suffix}`)).status;
        for (const asset of assets) {
            expect(await status("0.1.0", asset)).toBe(200);
            expect(await status("0.1.0", asset, ".sha256")).toBe(200);
        }
        expect((await fetch(`${address}/control/scenario?mode=no-desktop&version=0.1.0`, { method: "POST" })).status).toBe(200);
        expect(await status("0.1.0", "vera-darwin-arm64.tar.gz")).toBe(200);
        for (const asset of assets.slice(1)) {
            expect(await status("0.1.0", asset)).toBe(404);
            expect(await status("0.1.0", asset, ".sha256")).toBe(404);
            expect(await status("0.0.9", asset)).toBe(200);
        }
        expect((await fetch(`${address}/control/scenario?mode=normal&version=0.1.0`, { method: "POST" })).status).toBe(200);
        expect(await status("0.1.0", assets[1]!)).toBe(200);
    } finally {
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);
        rmSync(out, { recursive: true, force: true });
    }
}, 20_000);

test("by-hand instructions name the tunnel, both releases and the desktop install", () => {
    const text = otherMacCommands("/tmp/vr.out", "0.0.9", "0.1.0", true);
    expect(text).toContain("ssh -R 127.0.0.1:18765:127.0.0.1:18765 USER@OTHER-MAC");
    expect(text).toContain("serve /tmp/vr.out --port 18765");
    expect(text).toContain("VERA_VERSION=0.0.9 VERA_DESKTOP=yes sh");
    expect(text).toContain("export VERA_RELEASES_API=http://127.0.0.1:18765/releases VERA_RELEASES_DOWNLOAD_BASE=http://127.0.0.1:18765");
    expect(text).toContain("update to Vera 0.1.0");
    expect(text).not.toContain("holds the update");
    expect(otherMacCommands("/tmp/vr.out", "0.0.9", "0.1.0", false)).toContain("Vera 0.1.0 has no desktop assets in this build, so step 4 holds the update.");
});

test("build refuses unknown flags and a held newer release on a Linux build before building anything", async () => {
    const out = mkdtempSync(join(tmpdir(), "vera-rehearsal-flags-"));
    try {
        for (const [flags, message] of [
            [["--nope"], "Unknown build flag"],
            [["--linux", "--no-newer-desktop"], "--no-newer-desktop applies to the macOS build"],
            [["--newer-shell", "--no-desktop"], "--newer-shell needs the macOS desktop assets in both releases"],
            [["--newer-shell", "--no-newer-desktop"], "--newer-shell needs the macOS desktop assets in both releases"],
            [["--newer-shell", "--linux"], "--newer-shell needs the macOS desktop assets in both releases"],
        ] as const) {
            const child = Bun.spawn([process.execPath, script, "build", join(out, "feed"), "0.0.9", "0.1.0", ...flags], { stdout: "pipe", stderr: "pipe" });
            expect(await child.exited).toBe(1);
            expect(await new Response(child.stderr).text()).toContain(message);
        }
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}, 20_000);
