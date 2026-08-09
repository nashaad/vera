export function sourceVersion(cwd: string = import.meta.dir): string {
    const revision = Bun.spawnSync(
        ["git", "rev-parse", "--short", "HEAD"],
        { cwd, stdout: "pipe", stderr: "ignore" },
    );
    if (revision.exitCode !== 0) return "source";
    const value = revision.stdout.toString().trim();
    if (value.length === 0) return "source";

    const status = Bun.spawnSync(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        { cwd, stdout: "pipe", stderr: "ignore" },
    );
    const dirty = status.exitCode === 0 && status.stdout.length > 0
        ? "+dirty"
        : "";
    return `source ${value}${dirty}`;
}
