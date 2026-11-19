import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PROTOCOL_VERSION, requestHostIdentity } from "../../src/host/protocol.ts";
import { socketTest } from "../support/socket-probe.ts";
import { seedTestRelease } from "../support/seed-test-release.ts";

socketTest("unattended boot protects an answering host with a missing lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-bu-"));
    const home = join(root, "h");
    const socketPath = join(home, "runtime", "host.sock");
    const requests: string[] = [];
    const pid = 987654321;
    const server = createServer((socket) => {
        let input = "";
        socket.on("data", (chunk) => {
            input += chunk.toString();
            if (!input.includes("\n")) return;
            const request = JSON.parse(input.slice(0, input.indexOf("\n"))) as { type: string };
            requests.push(request.type);
            if (request.type === "host_identity") {
                socket.end(`${JSON.stringify({
                    type: "host_identity", pid, started_at: "2026-11-17T00:00:00.000Z",
                    protocol_version: HOST_PROTOCOL_VERSION, build_id: "dev",
                })}\n`);
            } else {
                socket.end();
            }
        });
    });
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
        await mkdir(join(home, "runtime"), { recursive: true });
        seedTestRelease(root);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => resolve());
        });
        for (const args of [["boot"], ["boot", "--json"]]) {
            child = Bun.spawn([process.execPath, "clients/cli/main.ts", ...args], {
                cwd: process.cwd(),
                env: { ...process.env, HOME: root, VERA_HOME: home },
                stdin: "ignore", stdout: "pipe", stderr: "pipe",
            });
            const [code, output, errors] = await Promise.all([
                child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ]);
            expect(code, `${output}\n${errors}`).toBe(1);
            expect(`${output}\n${errors}`).toContain("vera host reset");
            expect(`${output}\n${errors}`).toContain(`missing while host PID ${pid} answers`);
            if (!args.includes("--json")) expect(`${output}\n${errors}`).toContain("No recovery was run.");
            if (args.includes("--json")) {
                const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
                expect(lines.find((line) => line.type === "question")?.id).toBe("stop_answering_host");
                expect(lines.at(-1)?.type).toBe("failed");
            }
            expect((await requestHostIdentity(socketPath))?.pid).toBe(pid);
            expect(requests.every((type) => type === "host_identity")).toBe(true);
            await expect(readFile(join(home, "runtime", "host.json"))).rejects.toMatchObject({ code: "ENOENT" });
            await expect(readdir(join(home, "runtime", "backups"))).rejects.toMatchObject({ code: "ENOENT" });
            child = undefined;
        }

        await writeFile(join(home, "config.json"), JSON.stringify({
            schema_version: 1,
            model: "stub/example-model",
            extensions: [{ enabled: true }],
        }));
        child = Bun.spawn([process.execPath, "clients/cli/main.ts", "boot", "--json"], {
            cwd: process.cwd(),
            env: { ...process.env, HOME: root, VERA_HOME: home },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [code, output, errors] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(code, `${output}\n${errors}`).toBe(1);
        const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines.some((line) => line.type === "question")).toBe(false);
        expect(lines.at(-1)?.type).toBe("failed");
        expect(lines.at(-1)?.message).toContain("extensions[0]: path is missing");
        expect((await requestHostIdentity(socketPath))?.pid).toBe(pid);
        expect(requests.every((type) => type === "host_identity")).toBe(true);
        await expect(readFile(join(home, "runtime", "host.json"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readdir(join(home, "runtime", "backups"))).rejects.toMatchObject({ code: "ENOENT" });
        child = undefined;
    } finally {
        if (child !== undefined && child.exitCode === null) {
            child.kill("SIGTERM");
            await child.exited;
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);
