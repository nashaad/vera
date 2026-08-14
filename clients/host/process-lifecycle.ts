import type { ResidentHost } from "../../src/host/runtime.ts";

interface ShutdownSignalWait {
    readonly promise: Promise<void>;
    dispose(): void;
}

export interface ResidentHostProcessOptions {
    readonly waitForSignal?: () => ShutdownSignalWait;
    readonly exit?: (code: number) => void;
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
        await host.close();
    }

    // This process owns nothing after close. Exit explicitly because Bun can
    // retain a macOS network-monitor handle after its application sockets close.
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
