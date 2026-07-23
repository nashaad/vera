import {
    afterEach,
    expect,
    test,
} from "bun:test";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import {
    ExtensionLoadError,
    startUserExtension,
    type ExtensionDiagnostic,
    type ExtensionRuntimeFailure,
} from "../../src/extensions/supervisor.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("supervisor activates, attributes diagnostics, and disposes", async () => {
    const workspace = createDirectory();
    const directory = createExtension(`
        import { appendFile } from "node:fs/promises";
        export async function activate(vera) {
            console.log("loaded", process.env.VERA_EXTENSION_ID);
            await Bun.write(
                vera.workspace + "/environment.json",
                JSON.stringify({
                    id: process.env.VERA_EXTENSION_ID,
                    secret: process.env.VERA_TEST_SECRET,
                    config: vera.config,
                }),
            );
            vera.onDispose(() =>
                appendFile(vera.workspace + "/cleanup.txt", "done")
            );
        }
    `);
    const diagnostics: ExtensionDiagnostic[] = [];
    process.env.VERA_TEST_SECRET = "must-not-cross";
    try {
        const running = await startUserExtension({
            loaded: loadExtensionManifest(directory),
            config: { enabled: true },
            workspace,
            activationTimeoutMs: 1_000,
            disposeTimeoutMs: 1_000,
            terminateGraceMs: 100,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });

        expect(running.id).toBe("test.extension");
        expect(running.processId).toBeGreaterThan(0);
        expect(JSON.parse(readFileSync(
            join(workspace, "environment.json"),
            "utf8",
        ))).toEqual({
            id: "test.extension",
            config: { enabled: true },
        });
        await running.dispose();
        expect(readFileSync(join(workspace, "cleanup.txt"), "utf8"))
            .toBe("done");
        expect(diagnostics).toContainEqual({
            extensionId: "test.extension",
            message: "loaded test.extension",
        });
    } finally {
        delete process.env.VERA_TEST_SECRET;
    }
});

test("supervisor attributes activation failure and reaps the child", async () => {
    const directory = createExtension(`
        export function activate() {
            throw new Error("broken activation");
        }
    `);

    await expect(startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        workspace: createDirectory(),
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
    })).rejects.toEqual(
        new ExtensionLoadError(
            "test.extension",
            "broken activation",
        ),
    );
});

test("activation timeout kills and reaps the child", async () => {
    const workspace = createDirectory();
    const pidPath = join(workspace, "pid.txt");
    const directory = createExtension(`
        export async function activate() {
            await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
            await new Promise(() => {});
        }
    `);

    await expect(startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        workspace,
        activationTimeoutMs: 100,
        disposeTimeoutMs: 20,
        terminateGraceMs: 100,
    })).rejects.toThrow("timed out");

    expectProcessDead(Number(readFileSync(pidPath, "utf8")));
});

test("dispose timeout escalates to SIGKILL and reaps the child", async () => {
    const workspace = createDirectory();
    const directory = createExtension(`
        export function activate(vera) {
            process.on("SIGTERM", () => {});
            vera.onDispose(() => new Promise(() => {}));
        }
    `);
    const running = await startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        workspace,
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 20,
        terminateGraceMs: 20,
    });

    await expect(running.dispose()).rejects.toThrow("timed out");
    expectProcessDead(running.processId);
});

test("supervisor reports an unexpected post-activation exit", async () => {
    const directory = createExtension(`
        export function activate() {
            setTimeout(() => process.exit(7), 20);
        }
    `);
    const failures: ExtensionRuntimeFailure[] = [];
    const running = await startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        workspace: createDirectory(),
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
        onFailure: (failure) => failures.push(failure),
    });

    await waitFor(() => failures.length === 1);

    expect(failures).toEqual([{
        extensionId: "test.extension",
        message: "Extension process exited with code 7",
    }]);
    await expect(running.dispose()).rejects.toThrow(/exited|closed/);
});

function createExtension(source: string): string {
    const directory = createDirectory();
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id: "test.extension",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: [],
    }));
    writeFileSync(join(directory, "extension.ts"), source);
    return directory;
}

function createDirectory(): string {
    const directory = join(
        tmpdir(),
        `vera-extension-supervisor-${crypto.randomUUID()}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) {
            return;
        }
        await Bun.sleep(5);
    }
    throw new Error("condition was not reached");
}

function expectProcessDead(pid: number): void {
    expect(() => process.kill(pid, 0)).toThrow();
}
