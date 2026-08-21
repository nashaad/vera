export function sourceVersion(cwd: string = import.meta.dir): string {
    const packagedVersion = process.env.VERA_RELEASE_VERSION;
    if (packagedVersion !== undefined && packagedVersion.length > 0) {
        return packagedVersion;
    }

    let revision: ReturnType<typeof Bun.spawnSync>;
    try {
        revision = Bun.spawnSync(
            ["git", "rev-parse", "--short", "HEAD"],
            { cwd, stdout: "pipe", stderr: "ignore" },
        );
    } catch {
        return "source";
    }
    if (revision.exitCode !== 0) return "source";
    if (revision.stdout === undefined) return "source";
    const value = revision.stdout.toString().trim();
    if (value.length === 0) return "source";

    let dirty = "";
    try {
        const status = Bun.spawnSync(
            ["git", "status", "--porcelain", "--untracked-files=normal"],
            { cwd, stdout: "pipe", stderr: "ignore" },
        );
        dirty = status.exitCode === 0 && status.stdout.length > 0
            ? "+dirty"
            : "";
    } catch {
        // A source build without Git still has a useful revision.
    }
    return `source ${value}${dirty}`;
}
