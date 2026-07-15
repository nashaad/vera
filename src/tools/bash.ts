import type { RegisteredTool, ToolExecutionResult } from "./types.ts";

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
    execute(input, context): Promise<ToolExecutionResult> {
        const command = input.command;
        if (typeof command !== "string") {
            throw new Error("bash tool requires a string command");
        }
        return runBash(command, context.workspace);
    },
};

export async function runBash(
    command: string,
    workspace: string,
): Promise<ToolExecutionResult> {
    const subprocess = Bun.spawn(["bash", "-lc", command], {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
    ]);
    const output = [stdout, stderr]
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();

    return {
        output: output || "(no output)",
        isError: exitCode !== 0,
    };
}
