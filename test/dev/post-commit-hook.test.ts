import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN = fileURLToPath(new URL("../../dev/hooks/lib/scan-stale-releases.sh", import.meta.url));
let root: string;
let staleEntry: string;
let stalePrefix: string;

function runScan(): ReturnType<typeof spawnSync> {
    return spawnSync(SCAN, [root], { encoding: "utf8" });
}

describe("post-commit stale release scan", () => {
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "vera-release-scan-"));
        staleEntry = join(root, "cg.5KgREq");
        stalePrefix = join(staleEntry, "x", "leg", ".local");
        const staleReleases = join(stalePrefix, "share", "vera", "releases");
        const secondStaleReleases = join(staleEntry, "y", "leg", ".local", "share", "vera", "releases");
        const freshReleases = join(root, "fresh", "x", "leg", ".local", "share", "vera", "releases");
        mkdirSync(staleReleases, { recursive: true });
        mkdirSync(secondStaleReleases, { recursive: true });
        mkdirSync(freshReleases, { recursive: true });
        const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const timestamp = oldDate.toISOString().replace(/[-:T.Z]/g, "").slice(0, 12) + ".00";
        for (const stalePath of [staleReleases, secondStaleReleases]) {
            const touched = spawnSync("touch", ["-t", timestamp, stalePath]);
            if (touched.status !== 0) throw new Error("could not age stale release directory");
        }
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test("@core reports stale install prefixes and a quoted removal command", () => {
        const result = runScan();

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Stale Vera release installs: 2 installs");
        expect(result.stderr).toContain(stalePrefix);
        expect(result.stderr).toContain(join(staleEntry, "y", "leg", ".local"));
        expect(result.stderr).toContain("Total:");
        expect(result.stderr).toContain(`rm -rf '${stalePrefix}'`);
        expect(result.stderr).toContain(`'${join(staleEntry, "y", "leg", ".local")}'`);
        expect(result.stderr).not.toContain(join(root, "fresh"));
    });

    test("@core scans without Python in an otherwise empty environment", () => {
        const result = spawnSync(SCAN, [root], { encoding: "utf8", env: {} });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("Stale Vera release installs: 2 installs");
    });

    test("@core skips newline paths without reporting partial paths", () => {
        const scanRoot = mkdtempSync(join(tmpdir(), "vera-release-newline-"));
        const invalid = join(scanRoot, "bad\npath", "share", "vera", "releases");
        const valid = join(scanRoot, "valid\ttab", "share", "vera", "releases");
        try {
            const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            for (const path of [invalid, valid]) {
                mkdirSync(path, { recursive: true });
                utimesSync(path, oldDate, oldDate);
            }
            const result = spawnSync(SCAN, [scanRoot], { encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(result.stderr).toContain("Stale Vera release installs: 1 install");
            expect(result.stderr).toContain(`'${join(scanRoot, "valid\ttab")}'`);
            expect(result.stderr).not.toContain("bad");
            expect(result.stderr).not.toContain("unknown");
        } finally {
            rmSync(scanRoot, { recursive: true, force: true });
        }
    });

    test("@core a fresh release prints nothing", () => {
        const result = spawnSync(SCAN, [join(root, "fresh")], { encoding: "utf8" });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
    });

    test("@core unknown directory sizes produce an unknown total", () => {
        const bin = mkdtempSync(join(tmpdir(), "vera-release-failing-du-"));
        const fakeDu = join(bin, "du");
        writeFileSync(fakeDu, "#!/bin/sh\nexit 1\n");
        chmodSync(fakeDu, 0o755);
        try {
            const result = spawnSync(SCAN, [root], {
                encoding: "utf8",
                env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
            });
            expect(result.status).toBe(0);
            expect(result.stderr).toContain("(unknown)");
            expect(result.stderr).toContain("Total: unknown");
        } finally {
            rmSync(bin, { recursive: true, force: true });
        }
    });

    test("@core measures all found prefixes with one du invocation", () => {
        const bin = mkdtempSync(join(tmpdir(), "vera-release-count-du-"));
        const log = join(bin, "du-log");
        try {
            writeFileSync(join(bin, "du"), '#!/bin/sh\nprintf "called\\n" >> "$DU_LOG"\nexec /usr/bin/du "$@"\n', { mode: 0o755 });
            const result = spawnSync(SCAN, [root], {
                encoding: "utf8",
                env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DU_LOG: log },
            });
            expect(result.status).toBe(0);
            expect(readFileSync(log, "utf8")).toBe("called\n");
            expect(result.stderr).toContain("Stale Vera release installs: 2 installs");
        } finally {
            rmSync(bin, { recursive: true, force: true });
        }
    });

    test("@core deduplicates roots, prunes node_modules and reports installs older than one day", () => {
        const folder = mkdtempSync(join(tmpdir(), "vera-release-boundary-"));
        const scanRoot = join(folder, "root");
        const alias = join(folder, "alias");
        const releases = join(scanRoot, "entry", "share", "vera", "releases");
        const pruned = join(scanRoot, "node_modules", "package", "share", "vera", "releases");
        try {
            mkdirSync(releases, { recursive: true });
            mkdirSync(pruned, { recursive: true });
            symlinkSync(scanRoot, alias);
            const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
            utimesSync(releases, oldDate, oldDate);
            utimesSync(pruned, oldDate, oldDate);
            const result = spawnSync(SCAN, [scanRoot, alias], { encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(result.stderr).toContain("Stale Vera release installs: 1 install");
            expect(result.stderr).toContain(join(scanRoot, "entry"));
            expect(result.stderr).not.toContain("node_modules");
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });

    test("@core caps size lines at ten while listing every removable prefix", () => {
        const manyRoot = mkdtempSync(join(tmpdir(), "vera-release-cap-"));
        const prefixes = Array.from({ length: 12 }, (_, index) => join(manyRoot, `install ${index}${index === 0 ? "'" : ""}`, ".local"));
        try {
            for (const prefix of prefixes) {
                mkdirSync(join(prefix, "share", "vera", "releases"), { recursive: true });
                const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
                utimesSync(join(prefix, "share", "vera", "releases"), oldDate, oldDate);
            }
            const result = spawnSync(SCAN, [manyRoot], { encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(result.stderr).toContain("Stale Vera release installs: 12 installs");
            expect(result.stderr).toContain("and 2 more");
            expect((result.stderr.match(/^  .* \(/gm) ?? []).length).toBe(10);
            const lines = result.stderr.trimEnd().split("\n");
            expect(lines[1]).toContain("Total:");
            expect(lines[12]).toBe("  and 2 more");
            expect(lines[13]).toContain("Remove with: rm -rf");
            for (const prefix of prefixes) {
                const quoted = `'${prefix.replace(/'/g, `'\\''`)}'`;
                expect(result.stderr).toContain(quoted);
            }
        } finally {
            rmSync(manyRoot, { recursive: true, force: true });
        }
    });

    test("@core prunes git and node_modules and does not descend into fresh release directories", () => {
        const pruneRoot = mkdtempSync(join(tmpdir(), "vera-release-prune-"));
        const releases = join(pruneRoot, "real", ".local", "share", "vera", "releases");
        const freshRelease = join(pruneRoot, "fresh", ".local", "share", "vera", "releases");
        const hiddenNested = join(freshRelease, "child", ".local", "share", "vera", "releases");
        const nested = join(releases, "nested", ".local", "share", "vera", "releases");
        const git = join(pruneRoot, ".git", "nested", ".local", "share", "vera", "releases");
        const modules = join(pruneRoot, "node_modules", "nested", ".local", "share", "vera", "releases");
        try {
            for (const path of [releases, nested, git, modules, hiddenNested]) mkdirSync(path, { recursive: true });
            const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            for (const path of [releases, nested, git, modules, hiddenNested]) utimesSync(path, oldDate, oldDate);
            const recent = new Date();
            utimesSync(freshRelease, recent, recent);
            const result = spawnSync(SCAN, [pruneRoot], { encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(result.stderr).toContain("Stale Vera release installs: 1 install");
            expect(result.stderr).toContain(join(pruneRoot, "real", ".local"));
            expect(result.stderr).not.toContain(join(pruneRoot, "fresh"));
            expect(result.stderr).not.toContain("node_modules");
            expect(result.stderr).not.toContain(".git");
            expect(result.stderr).not.toContain("nested");
        } finally {
            rmSync(pruneRoot, { recursive: true, force: true });
        }
    });

    test("@core prunes matched release trees before the depth limit", () => {
        const pruneRoot = mkdtempSync(join(tmpdir(), "vera-release-inner-"));
        const prefix = join(pruneRoot, "entry");
        const outer = join(prefix, "share", "vera", "releases");
        const inner = join(outer, "share", "vera", "releases");
        try {
            mkdirSync(inner, { recursive: true });
            const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            utimesSync(inner, oldDate, oldDate);
            expect(spawnSync(SCAN, [pruneRoot], { encoding: "utf8" }).stderr).toBe("");
            utimesSync(outer, oldDate, oldDate);
            const result = spawnSync(SCAN, [pruneRoot], { encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(result.stderr).toContain("Stale Vera release installs: 1 install");
            expect(result.stderr).toContain(`rm -rf '${prefix}'`);
            expect(result.stderr).not.toContain(`'${outer}'`);
        } finally {
            rmSync(pruneRoot, { recursive: true, force: true });
        }
    });

    test("@core an empty root prints nothing", () => {
        const emptyRoot = mkdtempSync(join(tmpdir(), "vera-release-empty-"));
        try {
            const result = spawnSync(SCAN, [emptyRoot], { encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("");
        } finally {
            rmSync(emptyRoot, { recursive: true, force: true });
        }
    });
});
