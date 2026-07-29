const MAX_SOURCE_CHARACTERS = 50_000;
const MAX_OUTPUT_CHARACTERS = 30_000;
const D2_TIMEOUT_SECONDS = 8;

export type D2CharacterSet = "unicode" | "ascii";

export interface D2Execution {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

export type ExecuteD2 = (
    source: string,
    characterSet: D2CharacterSet,
    workspace: string,
    signal: AbortSignal,
) => Promise<D2Execution>;

export async function renderD2(
    source: string,
    characterSet: D2CharacterSet,
    workspace: string,
    signal: AbortSignal,
    execute: ExecuteD2 = executeD2,
): Promise<{ readonly output: string; readonly isError: boolean }> {
    if (source.length > MAX_SOURCE_CHARACTERS) {
        return {
            output: `D2 source exceeds ${MAX_SOURCE_CHARACTERS} characters.`,
            isError: true,
        };
    }

    let execution: D2Execution;
    try {
        execution = await execute(source, characterSet, workspace, signal);
    } catch (error) {
        if (isMissingD2(error)) {
            return {
                output: "D2 is not installed or is not available on PATH.",
                isError: true,
            };
        }
        throw error;
    }

    if (execution.exitCode !== 0) {
        const error = execution.stderr.trim()
            || `D2 exited with code ${execution.exitCode}.`;
        return {
            output: boundOutput(error),
            isError: true,
        };
    }
    const output = execution.stdout.trimEnd();
    if (output.length === 0) {
        return { output: "D2 produced no diagram.", isError: true };
    }
    return { output: boundOutput(output), isError: false };
}

function boundOutput(output: string): string {
    return output.length <= MAX_OUTPUT_CHARACTERS
        ? output
        : output.slice(0, MAX_OUTPUT_CHARACTERS)
            + `\n… (diagram truncated at ${MAX_OUTPUT_CHARACTERS} characters)`;
}

async function executeD2(
    source: string,
    characterSet: D2CharacterSet,
    workspace: string,
    signal: AbortSignal,
): Promise<D2Execution> {
    signal.throwIfAborted();
    const asciiMode = characterSet === "unicode" ? "extended" : "standard";
    const subprocess = Bun.spawn([
        "d2",
        "--timeout",
        String(D2_TIMEOUT_SECONDS),
        "--ascii-mode",
        asciiMode,
        "--stdout-format",
        "txt",
        "-",
        "-",
    ], {
        cwd: workspace,
        stdin: new Blob([source]),
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
    });
    const stop = (): void => {
        try {
            if (process.platform === "win32") {
                subprocess.kill();
            } else {
                process.kill(-subprocess.pid, "SIGKILL");
            }
        } catch {
            // The process may finish between cancellation and signal delivery.
        }
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(subprocess.stdout).text(),
            new Response(subprocess.stderr).text(),
            subprocess.exited,
        ]);
        return { stdout, stderr, exitCode };
    } finally {
        signal.removeEventListener("abort", stop);
    }
}

function isMissingD2(error: unknown): boolean {
    return error instanceof Error
        && (
            error.message.includes("ENOENT")
            || error.message.includes("Executable not found")
        );
}
