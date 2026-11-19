export function run(command: string, args: readonly string[]): string {
    const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr.toString().trim()}`,
        );
    }
    return result.stdout.toString();
}
