import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { join } from "node:path";

import type { JsonValue } from "../sdk/hooks.ts";
import type { LoadedExtensionManifest } from "./manifest.ts";
import {
    createExtensionRpcPeer,
    EXTENSION_RPC_VERSION,
    ExtensionRpcRemoteError,
    type ExtensionRpcPeer,
} from "./rpc.ts";

export interface StartUserExtensionOptions {
    readonly loaded: LoadedExtensionManifest;
    readonly config: JsonValue;
    readonly workspace: string;
    readonly activationTimeoutMs: number;
    readonly disposeTimeoutMs: number;
    readonly terminateGraceMs: number;
    readonly onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
    readonly onFailure?: (failure: ExtensionRuntimeFailure) => void;
}

export interface ExtensionDiagnostic {
    readonly extensionId: string;
    readonly message: string;
}

export interface ExtensionRuntimeFailure {
    readonly extensionId: string;
    readonly message: string;
}

export interface RunningUserExtension {
    readonly id: string;
    readonly processId: number;
    dispose(): Promise<void>;
}

export class ExtensionLoadError extends Error {
    readonly extensionId: string;

    constructor(extensionId: string, message: string) {
        super(`Extension ${extensionId} failed to load: ${message}`);
        this.name = "ExtensionLoadError";
        this.extensionId = extensionId;
    }
}

export async function startUserExtension(
    options: StartUserExtensionOptions,
): Promise<RunningUserExtension> {
    const extensionId = options.loaded.manifest.id;
    const child = spawn(process.execPath, [
        join(import.meta.dir, "child-runtime.ts"),
        options.loaded.entrypointPath,
    ], {
        cwd: options.loaded.directory,
        env: extensionEnvironment(extensionId),
        stdio: ["pipe", "pipe", "pipe"],
    });
    let intentionalExit = false;
    let activated = false;
    let disposal: Promise<void> | undefined;
    let unexpectedExit: ExtensionRpcRemoteError | undefined;
    const peer = createExtensionRpcPeer({
        input: child.stdout,
        output: child.stdin,
        label: `extension ${extensionId}`,
        requestIdPrefix: "h",
    });

    void forwardDiagnostics(
        child,
        extensionId,
        options.onDiagnostic,
    ).catch(() => undefined);
    child.once("exit", (code, signal) => {
        const message = processExitMessage(code, signal);
        const exitError = new ExtensionRpcRemoteError("exited", message);
        if (!intentionalExit) {
            unexpectedExit = exitError;
        }
        peer.close(exitError);
        if (activated && !intentionalExit) {
            safelyReportFailure(options.onFailure, {
                extensionId,
                message,
            });
        }
    });

    try {
        await waitForSpawn(child);
        const result = await peer.request("activate", {
            rpcVersion: EXTENSION_RPC_VERSION,
            extensionId,
            extensionVersion: options.loaded.manifest.version,
            capabilities: [...options.loaded.manifest.capabilities],
            config: structuredClone(options.config),
            workspace: options.workspace,
        }, {
            timeoutMs: options.activationTimeoutMs,
        });
        if (!isEmptyActivationResult(result)) {
            throw new Error("returned an invalid activation result");
        }
        if (unexpectedExit !== undefined) {
            throw unexpectedExit;
        }
        activated = true;
    } catch (error) {
        intentionalExit = true;
        peer.close();
        let message = errorMessage(error);
        try {
            await terminateChild(child, options.terminateGraceMs);
        } catch (terminationError) {
            message += `; process cleanup failed: ${errorMessage(terminationError)}`;
        }
        throw new ExtensionLoadError(extensionId, message);
    }

    return {
        id: extensionId,
        processId: child.pid!,
        dispose(): Promise<void> {
            disposal ??= dispose();
            return disposal;
        },
    };

    async function dispose(): Promise<void> {
        if (unexpectedExit !== undefined) {
            throw new Error(
                `Extension ${extensionId} cleanup failed: ${unexpectedExit.message}`,
            );
        }
        let failure: unknown;
        try {
            await peer.request("dispose", null, {
                timeoutMs: options.disposeTimeoutMs,
            });
        } catch (error) {
            failure = error;
        } finally {
            intentionalExit = true;
            peer.close();
            await terminateChild(child, options.terminateGraceMs);
        }
        if (failure !== undefined) {
            throw new Error(
                `Extension ${extensionId} cleanup failed: ${errorMessage(failure)}`,
            );
        }
    }
}

function extensionEnvironment(extensionId: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        VERA_EXTENSION_ID: extensionId,
    };
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
        const value = process.env[name];
        if (value !== undefined) {
            environment[name] = value;
        }
    }
    for (const [name, value] of Object.entries(process.env)) {
        if (name.startsWith("LC_") && value !== undefined) {
            environment[name] = value;
        }
    }
    return environment;
}

async function forwardDiagnostics(
    child: ChildProcessWithoutNullStreams,
    extensionId: string,
    report: StartUserExtensionOptions["onDiagnostic"],
): Promise<void> {
    let buffered = "";
    for await (const chunk of child.stderr) {
        buffered += chunk.toString();
        while (true) {
            const newlineAt = buffered.indexOf("\n");
            if (newlineAt === -1) {
                break;
            }
            safelyReportDiagnostic(report, {
                extensionId,
                message: buffered.slice(0, newlineAt),
            });
            buffered = buffered.slice(newlineAt + 1);
        }
    }
    if (buffered.length > 0) {
        safelyReportDiagnostic(report, {
            extensionId,
            message: buffered,
        });
    }
}

function safelyReportDiagnostic(
    report: StartUserExtensionOptions["onDiagnostic"],
    diagnostic: ExtensionDiagnostic,
): void {
    try {
        report?.(diagnostic);
    } catch {
        // Diagnostics must not affect extension lifecycle.
    }
}

function safelyReportFailure(
    report: StartUserExtensionOptions["onFailure"],
    failure: ExtensionRuntimeFailure,
): void {
    try {
        report?.(failure);
    } catch {
        // Failure reporting must not affect process cleanup.
    }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.pid !== undefined) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });
}

async function terminateChild(
    child: ChildProcessWithoutNullStreams,
    graceMs: number,
): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.kill("SIGTERM");
    if (await waitForExit(child, graceMs)) {
        return;
    }
    child.kill("SIGKILL");
    if (!await waitForExit(child, graceMs)) {
        throw new Error(
            `Extension process ${child.pid ?? "unknown"} did not exit after SIGKILL`,
        );
    }
}

function waitForExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
        }, timeoutMs);
        const onExit = (): void => {
            clearTimeout(timeout);
            resolve(true);
        };
        child.once("exit", onExit);
    });
}

function isEmptyActivationResult(
    value: JsonValue,
): value is { readonly handlers: readonly [] } {
    return isPlainObject(value)
        && Object.keys(value).length === 1
        && Array.isArray(value.handlers)
        && value.handlers.length === 0;
}

function isPlainObject(
    value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function processExitMessage(
    code: number | null,
    signal: NodeJS.Signals | null,
): string {
    if (signal !== null) {
        return `Extension process exited from ${signal}`;
    }
    return `Extension process exited with code ${code ?? "unknown"}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
