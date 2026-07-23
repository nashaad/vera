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
        return runBash(command, context.workspace, signal);
    },
};

export async function runBash(
    command: string,
    workspace: string,
    signal?: AbortSignal,
): Promise<ToolOutput> {
    signal?.throwIfAborted();
    const subprocess = Bun.spawn(["bash", "-lc", command], {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
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
        [stdout, stderr, exitCode] = await Promise.all([
            new Response(subprocess.stdout).text(),
            new Response(subprocess.stderr).text(),
            subprocess.exited,
        ]);
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
