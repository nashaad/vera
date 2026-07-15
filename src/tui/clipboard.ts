export interface Osc52Clipboard {
    copyToClipboardOSC52(text: string): boolean;
}

export async function copyTuiText(
    text: string,
    clipboard: Osc52Clipboard,
): Promise<void> {
    if (clipboard.copyToClipboardOSC52(text)) {
        return;
    }

    if (process.platform !== "darwin") {
        throw new Error("The terminal does not support clipboard copy");
    }

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
}

export function countTuiCharacters(text: string): number {
    return Array.from(text).length;
}
