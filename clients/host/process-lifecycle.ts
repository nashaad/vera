import type { ResidentHost } from "../../src/host/runtime.ts";

interface ShutdownSignalWait {
    readonly promise: Promise<void>;
    dispose(): void;
}

export interface ResidentHostProcessOptions {
    readonly waitForSignal?: () => ShutdownSignalWait;
    readonly exit?: (code: number) => void;
    readonly stopAbsorbingFaults?: () => void;
}

type CloseableResidentHost = Pick<ResidentHost, "shutdownRequested" | "close">;

export async function runResidentHostProcess(
    host: CloseableResidentHost,
    options: ResidentHostProcessOptions = {},
): Promise<void> {
    const signal = (options.waitForSignal ?? waitForShutdownSignal)();
    try {
        await Promise.race([signal.promise, host.shutdownRequested]);
    } finally {
        signal.dispose();
        options.stopAbsorbingFaults?.();
        try {
            await host.close();
        } catch (error) {
            process.stderr.write(
                `Resident Vera host failed to close: ${
                    error instanceof Error ? error.message : String(error)
                }\n`,
            );
            (options.exit ?? ((code) => process.exit(code)))(1);
        }
    }

    (options.exit ?? ((code) => process.exit(code)))(0);
}

function waitForShutdownSignal(): ShutdownSignalWait {
    let dispose = (): void => {};
    const promise = new Promise<void>((resolve) => {
        const stop = (): void => {
            dispose();
            resolve();
        };
        dispose = () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
    return { promise, dispose };
}
