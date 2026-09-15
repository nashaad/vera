export function editorCommand(
    environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
    const configured = environment.VISUAL?.trim()
        || environment.EDITOR?.trim()
        || "vi";
    const parts = configured.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
        ?.map((part) => part.replace(/^['"]|['"]$/g, ""))
        .filter((part) => part.length > 0);
    return parts === undefined || parts.length === 0 ? ["vi"] : parts;
}

export async function openFileInEditor(
    path: string,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    const subprocess = Bun.spawn([...editorCommand(environment), path], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await subprocess.exited;
    if (exitCode !== 0) {
        throw new Error(`Editor exited with status ${exitCode}`);
    }
}
