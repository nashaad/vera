import {
    afterEach,
    expect,
    test,
} from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createExtensionRpcPeer,
    EXTENSION_RPC_VERSION,
    type ExtensionRpcPeer,
} from "../../src/extensions/rpc.ts";

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
    for (const child of children.splice(0)) {
        child.kill("SIGKILL");
    }
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("child runtime activates an extension and redirects console output", async () => {
    const entrypoint = createEntrypoint(`
        export async function activate(vera) {
            console.log("extension says", vera.config.name);
            console.table([{ console: "stays on stderr" }]);
            await Bun.write(
                vera.config.outputPath,
                String(vera.config.name),
            );
        }
    `);
    const child = startChild(entrypoint);
    const peer = createHostPeer(child);
    const stderr = readText(child.stderr!);
    const workspace = createDirectory();

    await expect(peer.request("activate", {
        rpcVersion: EXTENSION_RPC_VERSION,
        extensionId: "test.extension",
        extensionVersion: "1.0.0",
        capabilities: [],
        config: {
            name: "Vera",
            outputPath: join(workspace, "activated.txt"),
        },
    }, { timeoutMs: 1_000 })).resolves.toEqual({ handlers: [] });
    await expect(Bun.file(join(workspace, "activated.txt")).text())
        .resolves.toBe("Vera");

    peer.close();
    child.kill();
    await expect(stderr).resolves.toContain("extension says Vera");
});

test("child runtime rejects overlapping activation", async () => {
    const directory = createDirectory();
    const countPath = join(directory, "count.txt");
    const entrypoint = createEntrypoint(`
        export async function activate() {
            await Bun.write(${JSON.stringify(countPath)}, "once");
            await Bun.sleep(50);
        }
    `);
    const child = startChild(entrypoint);
    const peer = createHostPeer(child);

    const first = activate(peer);
    await Bun.sleep(10);
    await expect(activate(peer)).rejects.toThrow(
        "already activated",
    );
    await expect(first).resolves.toEqual({ handlers: [] });
    await expect(Bun.file(countPath).text()).resolves.toBe("once");
    peer.close();
});

test("child runtime disposes registrations in reverse order", async () => {
    const directory = createDirectory();
    const cleanupPath = join(directory, "cleanup.txt");
    const entrypoint = createEntrypoint(`
        import { appendFile } from "node:fs/promises";
        export function activate(vera) {
            vera.onDispose(() => appendFile(${JSON.stringify(cleanupPath)}, "a"));
            vera.onDispose(() => appendFile(${JSON.stringify(cleanupPath)}, "b"));
        }
    `);
    const child = startChild(entrypoint);
    const peer = createHostPeer(child);

    await activate(peer);
    await expect(peer.request(
        "dispose",
        null,
        { timeoutMs: 1_000 },
    )).resolves.toBeNull();
    await expect(Bun.file(cleanupPath).text()).resolves.toBe("ba");

    peer.close();
});

test("child runtime attributes a missing activate export", async () => {
    const entrypoint = createEntrypoint("export const value = 1;");
    const child = startChild(entrypoint);
    const peer = createHostPeer(child);

    await expect(activate(peer)).rejects.toThrow(
        "must export an activate function",
    );
    peer.close();
});

test("concurrent disposal waits for the same failing cleanup", async () => {
    const directory = createDirectory();
    const cleanupPath = join(directory, "cleanup.txt");
    const entrypoint = createEntrypoint(`
        import { appendFile } from "node:fs/promises";
        export function activate(vera) {
            vera.onDispose(async () => {
                await Bun.sleep(25);
                await appendFile(${JSON.stringify(cleanupPath)}, "once");
                throw new Error("cleanup broke");
            });
        }
    `);
    const child = startChild(entrypoint);
    const peer = createHostPeer(child);
    await activate(peer);

    const first = peer.request("dispose", null, { timeoutMs: 1_000 });
    const second = peer.request("dispose", null, { timeoutMs: 1_000 });
    const results = await Promise.allSettled([first, second]);
    expect(results).toHaveLength(2);
    for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
            expect(result.reason).toMatchObject({
                message: expect.stringContaining(
                    "disposer 1: cleanup broke",
                ),
            });
        }
    }
    await expect(Bun.file(cleanupPath).text()).resolves.toBe("once");
    peer.close();
});

test("child runtime returns protocol mismatch explicitly", async () => {
    const child = startChild(createEntrypoint(
        "export function activate() {}",
    ));
    const peer = createHostPeer(child);

    await expect(peer.request("activate", {
        rpcVersion: EXTENSION_RPC_VERSION + 1,
        extensionId: "test.extension",
        extensionVersion: "1.0.0",
        capabilities: [],
        config: null,
    }, { timeoutMs: 1_000 })).rejects.toMatchObject({
        code: "protocol_mismatch",
    });
    peer.close();
});

function createEntrypoint(source: string): string {
    const directory = createDirectory();
    const path = join(directory, "extension.ts");
    writeFileSync(path, source);
    return path;
}

function createDirectory(): string {
    const directory = join(
        tmpdir(),
        `vera-extension-child-${crypto.randomUUID()}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    return directory;
}

function startChild(entrypoint: string): ChildProcess {
    const child = spawn(process.execPath, [
        join(import.meta.dir, "../../src/extensions/child-runtime.ts"),
        entrypoint,
    ], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
}

function createHostPeer(child: ChildProcess): ExtensionRpcPeer {
    if (child.stdout === null || child.stdin === null) {
        throw new Error("extension child streams are unavailable");
    }
    return createExtensionRpcPeer({
        input: child.stdout,
        output: child.stdin,
        label: "extension host",
        requestIdPrefix: "h",
    });
}

function activate(
    peer: ExtensionRpcPeer,
): Promise<unknown> {
    return peer.request("activate", {
        rpcVersion: EXTENSION_RPC_VERSION,
        extensionId: "test.extension",
        extensionVersion: "1.0.0",
        capabilities: [],
        config: null,
    }, { timeoutMs: 1_000 });
}

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
    let text = "";
    for await (const chunk of stream) {
        text += chunk.toString();
    }
    return text;
}
