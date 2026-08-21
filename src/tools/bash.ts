import {
    captureBounded,
    BASH_CAPTURE_LIMIT_BYTES,
} from "./bounded-capture.ts";
import type { RegisteredTool, ToolOutput } from "./types.ts";

export const bashTool: RegisteredTool = {
    definition: {
        name: "bash",
        description: "Run a shell command in the current working directory.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string" },
            },
            required: ["command"],
            additionalProperties: false,
        },
    },
    execute(input, context, signal): Promise<ToolOutput> {
        const command = input.command;
        if (typeof command !== "string") {
            throw new Error("bash tool requires a string command");
        }
        return runBash(command, context.workspace, signal, context.env);
    },
};

export async function runBash(
    command: string,
    workspace: string,
    signal?: AbortSignal,
    env?: Readonly<Record<string, string>>,
): Promise<ToolOutput> {
    signal?.throwIfAborted();
    const subprocess = Bun.spawn(["bash", "-lc", command], {
        cwd: workspace,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    const stop = (): void => {
        try {
            if (process.platform === "win32") {
                Bun.spawnSync([
                    "taskkill",
                    "/pid",
                    String(subprocess.pid),
                    "/t",
                    "/f",
                ], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
            } else {
                process.kill(-subprocess.pid, "SIGKILL");
            }
        } catch {
            // The process may have exited between the abort and signal delivery.
        }
    };
    signal?.addEventListener("abort", stop, { once: true });

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
        // Both streams share the budget, half each, so a command that says
        // everything on stderr is bounded the same as one that says it on
        // stdout. Both are read to their end whatever the budget, because a
        // child blocked on a full pipe never reaches its exit.
        const [stdoutCapture, stderrCapture, code] = await Promise.all([
            captureBounded(
                subprocess.stdout,
                BASH_CAPTURE_LIMIT_BYTES / 2,
                "stdout",
            ),
            captureBounded(
                subprocess.stderr,
                BASH_CAPTURE_LIMIT_BYTES / 2,
                "stderr",
            ),
            subprocess.exited,
        ]);
        stdout = stdoutCapture.text;
        stderr = stderrCapture.text;
        exitCode = code;
    } finally {
        signal?.removeEventListener("abort", stop);
    }
    const output = [stdout, stderr]
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();

    return {
        kind: "output",
        output: output || "(no output)",
        isError: exitCode !== 0,
    };
}
