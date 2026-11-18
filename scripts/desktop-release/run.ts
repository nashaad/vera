export function run(command: string, args: readonly string[], env: Record<string, string> = {}): string {
    const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    if (result.exitCode !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr.toString().trim()}`,
        );
    }
    return result.stdout.toString();
}
