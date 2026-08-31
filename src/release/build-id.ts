export function packedBuildId(cwd: string): string {
    const revision = Bun.spawnSync(
        ["git", "rev-parse", "--short", "HEAD"],
        { cwd, stdout: "pipe", stderr: "pipe" },
    );
    if (revision.exitCode !== 0) {
        const detail = revision.stderr.toString().trim();
        throw new Error(
            detail.length > 0
                ? `Packed build id needs git: ${detail}`
                : "Packed build id needs git rev-parse",
        );
    }
    const sha = revision.stdout.toString().trim();
    if (sha.length === 0) {
        throw new Error("Packed build id got an empty git revision");
    }
    const status = Bun.spawnSync(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const dirty = status.exitCode === 0
        && status.stdout.toString().trim().length > 0;
    return dirty ? `vera-${sha}+dirty` : `vera-${sha}`;
}
