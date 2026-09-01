import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspaceSidecarSupervisor } from "../../src/host/workspace-sidecars.ts";

async function writeProjectSidecar(
    workspace: string,
    outFile: string,
): Promise<void> {
    const directory = join(workspace, ".vera", "extensions", "acme.echo");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "extension.ts"), "export function activate() {}\n");
    await writeFile(
        join(directory, "worker.sh"),
        "#!/bin/sh\necho \"$VERA_SOCKET\" >> \"$OUT_FILE\"\nsleep 60\n",
    );
    await writeFile(
        join(directory, "vera.extension.json"),
        JSON.stringify({
            id: "acme.echo",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: [],
            contributes: {
                sidecars: [
                    {
                        id: "echo",
                        command: ["sh", "worker.sh"],
                        env: { OUT_FILE: outFile },
                    },
                ],
            },
        }),
    );
}

async function waitForLines(path: string, count: number): Promise<string[]> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const text = await readFile(path, "utf8").catch(() => "");
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length >= count) return lines;
        await Bun.sleep(20);
    }
    throw new Error(`sidecar did not write ${count} line(s) to ${path}`);
}

test("two acquires in one workspace start one sidecar", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-ws-sidecar-")));
    const workspace = join(root, "app");
    const outFile = join(root, "sidecar-out");
    await mkdir(workspace, { recursive: true });
    await writeProjectSidecar(workspace, outFile);
    const supervisor = createWorkspaceSidecarSupervisor({
        socketPath: () => join(root, "host.sock"),
        logDirectory: join(root, "logs"),
    });
    try {
        await supervisor.acquire(workspace);
        await supervisor.acquire(workspace);
        const lines = await waitForLines(outFile, 1);
        expect(lines).toEqual([join(root, "host.sock")]);
        await Bun.sleep(80);
        const again = await readFile(outFile, "utf8");
        expect(again.trim().split("\n")).toHaveLength(1);
    } finally {
        await supervisor.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("releasing the last session stops the workspace sidecar", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-ws-sidecar-stop-")));
    const workspace = join(root, "app");
    const outFile = join(root, "sidecar-out");
    await mkdir(workspace, { recursive: true });
    await writeProjectSidecar(workspace, outFile);
    const supervisor = createWorkspaceSidecarSupervisor({
        socketPath: () => join(root, "host.sock"),
        logDirectory: join(root, "logs"),
    });
    try {
        await supervisor.acquire(workspace);
        await waitForLines(outFile, 1);
        await supervisor.release(workspace);
        await rm(outFile, { force: true });
        await Bun.sleep(200);
        const after = await readFile(outFile, "utf8").catch(() => null);
        expect(after).toBeNull();
    } finally {
        await supervisor.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("starting workspace B does not stop workspace A", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-ws-sidecar-ab-")));
    const projectA = join(root, "a");
    const projectB = join(root, "b");
    const outA = join(root, "out-a");
    const outB = join(root, "out-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    await writeProjectSidecar(projectA, outA);
    await writeProjectSidecar(projectB, outB);
    const supervisor = createWorkspaceSidecarSupervisor({
        socketPath: () => join(root, "host.sock"),
        logDirectory: join(root, "logs"),
    });
    try {
        await supervisor.acquire(projectA);
        await waitForLines(outA, 1);
        await supervisor.acquire(projectB);
        await waitForLines(outB, 1);
        expect(supervisor.held(projectA)).toBe(true);
        expect(supervisor.held(projectB)).toBe(true);
        await supervisor.release(projectB);
        expect(supervisor.held(projectA)).toBe(true);
        expect(supervisor.held(projectB)).toBe(false);
        await rm(outB, { force: true });
        await Bun.sleep(200);
        expect(await readFile(outB, "utf8").catch(() => null)).toBeNull();
        expect(await readFile(outA, "utf8")).toContain("host.sock");
        await supervisor.release(projectA);
    } finally {
        await supervisor.close();
        await rm(root, { recursive: true, force: true });
    }
});
