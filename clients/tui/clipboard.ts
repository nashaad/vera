export interface Osc52Clipboard {
    copyToClipboardOSC52(text: string): boolean;
}

export interface NativeClipboard {
    copy(text: string): Promise<void>;
}

export interface CopyTuiTextOptions {
    readonly platform?: NodeJS.Platform;
    readonly nativeClipboard?: NativeClipboard;
}

export async function copyTuiText(
    text: string,
    clipboard: Osc52Clipboard,
    options: CopyTuiTextOptions = {},
): Promise<void> {
    const platform = options.platform ?? process.platform;
    let nativeError: unknown;

    if (platform === "darwin") {
        try {
            await (options.nativeClipboard ?? macClipboard).copy(text);
            return;
        } catch (error) {
            nativeError = error;
        }
    }

    if (clipboard.copyToClipboardOSC52(text)) {
        return;
    }

    if (nativeError instanceof Error) {
        throw nativeError;
    }
    throw new Error("The terminal does not support clipboard copy");
}

const macClipboard: NativeClipboard = {
    async copy(text: string): Promise<void> {
        const subprocess = Bun.spawn(["/usr/bin/pbcopy"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "pipe",
        });
        subprocess.stdin.write(text);
        subprocess.stdin.end();

        const exitCode = await subprocess.exited;
        if (exitCode !== 0) {
            const stderr = await new Response(subprocess.stderr).text();
            throw new Error(stderr.trim() || "pbcopy failed");
        }
    },
};

export function countTuiCharacters(text: string): number {
    return Array.from(text).length;
}
