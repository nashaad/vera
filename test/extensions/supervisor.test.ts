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
                vera.config.environmentPath,
                JSON.stringify({
                    id: process.env.VERA_EXTENSION_ID,
                    secret: process.env.VERA_TEST_SECRET,
                    config: vera.config,
                }),
            );
            vera.onDispose(() =>
                appendFile(vera.config.cleanupPath, "done")
            );
        }
    `);
    const diagnostics: ExtensionDiagnostic[] = [];
    process.env.VERA_TEST_SECRET = "must-not-cross";
    try {
        const running = await startUserExtension({
            loaded: loadExtensionManifest(directory),
            config: {
                enabled: true,
                environmentPath: join(workspace, "environment.json"),
                cleanupPath: join(workspace, "cleanup.txt"),
            },
            activationTimeoutMs: 1_000,
            disposeTimeoutMs: 1_000,
            terminateGraceMs: 100,
            handlerTimeoutMs: 1_000,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });

        expect(running.id).toBe("test.extension");
        expect(running.processId).toBeGreaterThan(0);
        expect(JSON.parse(readFileSync(
            join(workspace, "environment.json"),
            "utf8",
        ))).toEqual({
            id: "test.extension",
            config: {
                enabled: true,
                environmentPath: join(workspace, "environment.json"),
                cleanupPath: join(workspace, "cleanup.txt"),
            },
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

test("supervisor discovers and invokes a declarative command", async () => {
    const directory = createExtension(`
        export function activate(vera) {
            vera.commands.register({
                name: "hello",
                description: "Say hello",
                usage: "/hello [name]",
                async run({ argumentsText, workspace, signal }) {
                    if (signal.aborted) throw new Error("cancelled");
                    return {
                        kind: "text",
                        text: workspace + ":Hello "
                            + (argumentsText || "world"),
                    };
                },
            });
        }
    `, ["commands.register"]);
    const running = await startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
        handlerTimeoutMs: 1_000,
    });

    expect(running.commands).toEqual([{
        name: "hello",
        description: "Say hello",
        usage: "/hello [name]",
        source: "test.extension",
    }]);
    const commandWorkspace = createDirectory();
    await expect(running.invokeCommand(
        "hello",
        "Nash",
        commandWorkspace,
    )).resolves.toEqual({
        version: 1,
        source: "test.extension/hello",
        body: {
            kind: "text",
            text: `${commandWorkspace}:Hello Nash`,
        },
    });
    await running.dispose();
});

test("command timeout aborts the handler and leaves the extension usable", async () => {
    const workspace = createDirectory();
    const abortedPath = join(workspace, "aborted.txt");
    const directory = createExtension(`
        export function activate(vera) {
            vera.commands.register({
                name: "work",
                description: "Do work",
                usage: "/work [slow]",
                async run({ argumentsText, signal }) {
                    if (argumentsText !== "slow") {
                        return { kind: "notice", level: "info", text: "ready" };
                    }
                    await new Promise((resolve) => {
                        signal.addEventListener("abort", async () => {
                            await Bun.write(
                                ${JSON.stringify(abortedPath)},
                                "aborted",
                            );
                            resolve();
                        }, { once: true });
                    });
                    return { kind: "text", text: "late" };
                },
            });
        }
    `, ["commands.register"]);
    const running = await startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
        handlerTimeoutMs: 20,
    });

    await expect(running.invokeCommand(
        "work",
        "slow",
        workspace,
    )).rejects.toThrow(
        "timed out",
    );
    await waitFor(() => Bun.file(abortedPath).size > 0);
    await expect(running.invokeCommand(
        "work",
        "fast",
        workspace,
    )).resolves.toMatchObject({
        body: { kind: "notice", level: "info", text: "ready" },
    });
    await running.dispose();
});

test("dispose cancels active commands before extension cleanup", async () => {
    const workspace = createDirectory();
    const orderPath = join(workspace, "order.txt");
    const directory = createExtension(`
        import { appendFile } from "node:fs/promises";
        export function activate(vera) {
            vera.commands.register({
                name: "wait",
                description: "Wait",
                usage: "/wait",
                async run({ signal }) {
                    await new Promise((resolve) => {
                        signal.addEventListener("abort", resolve, { once: true });
                    });
                    await appendFile(${JSON.stringify(orderPath)}, "handler\\n");
                    return { kind: "text", text: "done" };
                },
            });
            vera.onDispose(() =>
                appendFile(${JSON.stringify(orderPath)}, "cleanup\\n")
            );
        }
    `, ["commands.register"]);
    const running = await startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
        handlerTimeoutMs: 1_000,
    });

    const invocation = running.invokeCommand("wait", "", workspace);
    await Bun.sleep(5);
    const outcomes = await Promise.allSettled([
        invocation,
        running.dispose(),
    ]);

    expect(outcomes[0]?.status).toBe("rejected");
    expect(outcomes[1]?.status).toBe("fulfilled");
    expect(readFileSync(orderPath, "utf8")).toBe("handler\ncleanup\n");
    await expect(running.invokeCommand(
        "wait",
        "",
        workspace,
    )).rejects.toMatchObject({
        code: "disposed",
    });
});

test("command registration requires its declared capability", async () => {
    const directory = createExtension(`
        export function activate(vera) {
            vera.commands.register({
                name: "hidden",
                description: "Hidden",
                usage: "/hidden",
                run() { return { kind: "text", text: "no" }; },
            });
        }
    `);

    await expect(startUserExtension({
        loaded: loadExtensionManifest(directory),
        config: null,
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
        handlerTimeoutMs: 1_000,
    })).rejects.toThrow("did not declare commands.register");
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
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
        handlerTimeoutMs: 1_000,
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
        activationTimeoutMs: 100,
        disposeTimeoutMs: 20,
        terminateGraceMs: 100,
        handlerTimeoutMs: 1_000,
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
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 20,
        terminateGraceMs: 20,
        handlerTimeoutMs: 1_000,
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
        activationTimeoutMs: 1_000,
        disposeTimeoutMs: 1_000,
        terminateGraceMs: 100,
        handlerTimeoutMs: 1_000,
        onFailure: (failure) => failures.push(failure),
    });

    await waitFor(() => failures.length === 1);

    expect(failures).toEqual([{
        extensionId: "test.extension",
        message: "Extension process exited with code 7",
    }]);
    await expect(running.dispose()).rejects.toThrow(/exited|closed/);
});

function createExtension(
    source: string,
    capabilities: readonly string[] = [],
): string {
    const directory = createDirectory();
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id: "test.extension",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities,
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
