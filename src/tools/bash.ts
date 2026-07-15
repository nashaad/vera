import type { ModelTool } from "../model/types.ts";

export interface BashResult {
    readonly output: string;
    readonly isError: boolean;
}

export const bashTool: ModelTool = {
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
};

export async function runBash(command: string): Promise<BashResult> {
    const subprocess = Bun.spawn(["bash", "-lc", command], {
        cwd: process.cwd(),
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
