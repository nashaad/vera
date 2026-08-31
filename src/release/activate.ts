import {
    chmodSync,
    mkdirSync,
    realpathSync,
    renameSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
    currentSymlinkPath,
    defaultInstallPrefix,
    launcherPath,
    RELEASE_CLI_NAME,
    releaseDirectory,
    veraShareRoot,
} from "./layout.ts";
import { readStampedRelease } from "./stamp.ts";

/**
 * Point `current` at this release and write the stable launcher. `current` is
 * replaced with rename(2), so readers see the previous target or the new one.
 */
export function activateRelease(
    releaseRoot: string,
    prefix = defaultInstallPrefix(),
): void {
    const manifest = readStampedRelease(releaseRoot);
    const expected = releaseDirectory(manifest.build_id, prefix);
    if (realpathSync(releaseRoot) !== realpathSync(expected)) {
        throw new Error(
            `Release ${manifest.build_id} must live at ${expected}`,
        );
    }
    const share = veraShareRoot(prefix);
    mkdirSync(share, { recursive: true, mode: 0o755 });
    const current = currentSymlinkPath(prefix);
    const temporary = join(share, `.current.${process.pid}`);
    try {
        unlinkSync(temporary);
    } catch {
        // The pid-scoped name should be free; ignore a leftover.
    }
    symlinkSync(join("releases", manifest.build_id), temporary);
    renameSync(temporary, current);
    writeLauncher(prefix);
}

function writeLauncher(prefix: string): void {
    const path = launcherPath(prefix);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const target = join(currentSymlinkPath(prefix), RELEASE_CLI_NAME);
    const script = `#!/bin/sh\n`
        + `set -eu\n`
        + `target=${shellSingleQuote(target)}\n`
        + `if [ ! -x "$target" ]; then\n`
        + `  echo "vera: no activated release at $target. Pack this tree first with bun run pack:release." >&2\n`
        + `  exit 1\n`
        + `fi\n`
        + `exec "$target" "$@"\n`;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, script, { encoding: "utf8", mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, path);
}

function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
