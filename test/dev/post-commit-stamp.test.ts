import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../../dev/hooks/post-commit", import.meta.url));

function runWithPath(hook: string, root: string, env: NodeJS.ProcessEnv, bin: string): ReturnType<typeof spawnSync> {
    return spawnSync("sh", [hook], {
        cwd: root,
        env: { ...env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
    });
}

test("@core post-commit scans at most once a day without suppressing backup", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-post-commit-stamp-"));
    const hooks = join(root, "hooks");
    const lib = join(hooks, "lib");
    const hook = join(hooks, "post-commit");
    const backupLog = join(root, "backups");
    const scanLog = join(root, "scans");
    try {
        mkdirSync(lib, { recursive: true });
        expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
        copyFileSync(HOOK, hook);
        writeFileSync(join(lib, "agent-backup.sh"), 'printf "backup\\n" >> "$BACKUP_LOG"\nexit 1\n');
        writeFileSync(join(lib, "scan-stale-releases.sh"), '#!/bin/sh\nprintf "scan\\n" >> "$SCAN_LOG"\nexit 1\n', { mode: 0o755 });
        const env: NodeJS.ProcessEnv = { ...process.env, BACKUP_LOG: backupLog, SCAN_LOG: scanLog };
        delete env.GIT_DIR;
        delete env.GIT_WORK_TREE;
        const run = () => spawnSync("sh", [hook], { cwd: root, env, encoding: "utf8" });

        expect(run().status).toBe(0);
        expect(run().status).toBe(0);
        expect(readFileSync(backupLog, "utf8")).toBe("backup\nbackup\n");
        expect(readFileSync(scanLog, "utf8")).toBe("scan\n");
        const stamp = join(root, ".git", "vera-stale-releases-scan.stamp");
        const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(stamp, oldDate, oldDate);
        expect(run().status).toBe(0);
        expect(readFileSync(backupLog, "utf8")).toBe("backup\nbackup\nbackup\n");
        expect(readFileSync(scanLog, "utf8")).toBe("scan\nscan\n");

        const bin = join(root, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "touch"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        utimesSync(stamp, oldDate, oldDate);
        const failedStamp = runWithPath(hook, root, env, bin);
        expect(failedStamp.status).toBe(0);
        expect(readFileSync(backupLog, "utf8")).toBe("backup\nbackup\nbackup\nbackup\n");
        expect(readFileSync(scanLog, "utf8")).toBe("scan\nscan\n");

        const scan = join(lib, "scan-stale-releases.sh");
        const oldStamp = statSync(stamp).mtimeMs;
        chmodSync(scan, 0o644);
        expect(run().status).toBe(0);
        expect(readFileSync(scanLog, "utf8")).toBe("scan\nscan\n");
        expect(statSync(stamp).mtimeMs).toBe(oldStamp);
        rmSync(scan);
        expect(run().status).toBe(0);
        expect(readFileSync(scanLog, "utf8")).toBe("scan\nscan\n");
        expect(statSync(stamp).mtimeMs).toBe(oldStamp);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
