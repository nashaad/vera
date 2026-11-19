import type { BootPreflight, PreflightHooks, PreflightResult } from "./boot.ts";
import { installBundledRelease } from "./release-install.ts";

// A second boot while an install runs waits for it, then sees the release already in place.
let queue: Promise<unknown> = Promise.resolve();

export function bundledInstallPreflight(bundleDirectory: string, prefix?: string): BootPreflight {
    return (hooks) => {
        const attempt = queue.then(() => install(bundleDirectory, prefix, hooks));
        queue = attempt.catch(() => undefined);
        return attempt;
    };
}

async function install(
    bundleDirectory: string,
    prefix: string | undefined,
    hooks: PreflightHooks,
): Promise<PreflightResult> {
    const outcome = await installBundledRelease({
        bundleDirectory,
        ...(prefix === undefined ? {} : { prefix }),
        onInstalling: hooks.installing,
    });
    if (outcome.kind !== "failed") return { kind: "continue" };
    const reason = sentence(outcome.reason);
    if (outcome.kept) {
        return { kind: "continue", notice: `${reason} Vera is using the release you already had.` };
    }
    return {
        kind: "stop",
        message: `Vera could not install the release inside this app. ${reason} Choose Try again to retry.`,
    };
}

function sentence(text: string): string {
    const trimmed = text.trim();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
