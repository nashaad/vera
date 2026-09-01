import { existsSync, watch } from "node:fs";
import { join } from "node:path";

export function watchWorkspaceBranch(
    workspace: string,
    onChange: () => void,
): { current(): string | undefined; stop(): void } {
    let branch = readBranch(workspace);
    const head = join(workspace, ".git", "HEAD");
    let watcher: ReturnType<typeof watch> | undefined;
    if (existsSync(head)) {
        try {
            watcher = watch(head, () => {
                const next = readBranch(workspace);
                if (next === branch) return;
                branch = next;
                onChange();
            });
            watcher.unref?.();
        } catch {
            watcher = undefined;
        }
    }
    return {
        current: () => branch,
        stop: () => watcher?.close(),
    };
}

function readBranch(workspace: string): string | undefined {
    const named = git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (named === undefined) return undefined;
    return named === "HEAD"
        ? git(workspace, ["rev-parse", "--short", "HEAD"])
        : named;
}

function git(workspace: string, args: readonly string[]): string | undefined {
    const result = Bun.spawnSync(["git", ...args], {
        cwd: workspace,
        stdout: "pipe",
        stderr: "ignore",
    });
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.toString().trim();
    return value.length === 0 ? undefined : value;
}
