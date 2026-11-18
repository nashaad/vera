import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
