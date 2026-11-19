import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    notInstalledMessage,
    packageMissingMessage,
    prefixOfLauncher,
    resolveShellBoot,
    shellTooOldMessage,
    type ShellBoot,
} from "../../clients/desktop/shell/bootstrap.ts";
import { noticePage } from "../../clients/desktop/shell/notice.ts";
import {
    DESKTOP_PACKAGE_MANIFEST_NAME,
    serializeDesktopPackageManifest,
} from "../../src/release/desktop-package-manifest.ts";
import {
    currentSymlinkPath,
    desktopPackageDirectory,
    desktopPackageReferencesDirectory,
    releaseDirectory,
} from "../../src/release/layout.ts";

const BUILD = "vera-build-a";
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Installed {
    readonly prefix: string;
    readonly launcher: string;
}

// A prefix with a launcher, a release and `current`, the way the installer leaves them.
function install(options: { readonly launcher?: "script" | "link" | "none"; readonly current?: boolean } = {}): Installed {
    const prefix = mkdtempSync(join(tmpdir(), "vera-shell-boot-"));
    roots.push(prefix);
    const release = releaseDirectory(BUILD, prefix);
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "vera"), "#!/bin/sh\n", { mode: 0o755 });
    if (options.current !== false) symlinkSync(join("releases", BUILD), currentSymlinkPath(prefix));
    const launcher = join(prefix, "bin", "vera");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    if (options.launcher === "link") {
        symlinkSync(join(currentSymlinkPath(prefix), "vera"), launcher);
    } else if (options.launcher !== "none") {
        writeFileSync(launcher, `#!/bin/sh\nexec '${join(currentSymlinkPath(prefix), "vera")}' "$@"\n`);
        chmodSync(launcher, 0o755);
    }
    return { prefix, launcher };
}

function place(prefix: string, version: string, extra: Record<string, unknown> = {}, hostBuildId = BUILD): void {
    const directory = desktopPackageDirectory(hostBuildId, version, prefix);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "main.js"), "// entry\n");
    const manifest = JSON.parse(serializeDesktopPackageManifest({
        layout_version: 1,
        desktop_version: version,
        host_build_id: hostBuildId,
        entry: "main.js",
        shell_api: 1,
    })) as Record<string, unknown>;
    writeFileSync(join(directory, DESKTOP_PACKAGE_MANIFEST_NAME), JSON.stringify({ ...manifest, ...extra }));
}

function unavailable(boot: ShellBoot): string {
    if (boot.kind !== "unavailable") throw new Error("expected the shell to have no package");
    return boot.message;
}

test("@core the shell takes the prefix from the vera launcher and loads the newest package for the current host build", () => {
    const { prefix, launcher } = install();
    place(prefix, "0.1.0");
    place(prefix, "0.3.0");
    place(prefix, "0.2.0");
    place(prefix, "9.0.0", {}, "vera-other-build");

    const boot = resolveShellBoot({ launcher });
    if (boot.kind !== "package") throw new Error(unavailable(boot));
    const record = join(desktopPackageReferencesDirectory(prefix), `${process.pid}.json`);
    try {
        expect(boot.prefix).toBe(prefix);
        expect(boot.package.desktopVersion).toBe("0.3.0");
        expect(boot.package.hostBuildId).toBe(BUILD);
        expect(boot.package.entryPath).toBe(join(desktopPackageDirectory(BUILD, "0.3.0", prefix), "main.js"));
        expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
            pid: process.pid,
            host_build_id: BUILD,
            desktop_version: "0.3.0",
        });
    } finally {
        boot.release();
    }
    expect(existsSync(record)).toBe(false);
});

test("a launcher that links into a release gives the prefix of that release", () => {
    const { prefix, launcher } = install({ launcher: "link" });
    place(prefix, "0.1.0");
    expect(prefixOfLauncher(launcher)).toBe(realpathSync(prefix));
    const boot = resolveShellBoot({ launcher });
    if (boot.kind !== "package") throw new Error(unavailable(boot));
    boot.release();
    expect(boot.package.desktopVersion).toBe("0.1.0");
});

test("without a launcher or a current release the shell says Vera is not installed", () => {
    expect(unavailable(resolveShellBoot({ launcher: join(tmpdir(), "vera-no-such-launcher") }))).toBe(notInstalledMessage());
    const none = install({ launcher: "none" });
    place(none.prefix, "0.1.0");
    expect(unavailable(resolveShellBoot({ launcher: none.launcher }))).toBe(notInstalledMessage());
    const unlinked = install({ current: false });
    place(unlinked.prefix, "0.1.0");
    expect(unavailable(resolveShellBoot({ launcher: unlinked.launcher }))).toBe(notInstalledMessage());
});

test("@core a current host build with no usable package gets the installer message and no record", () => {
    const { prefix, launcher } = install();
    place(prefix, "0.1.0", {}, "vera-other-build");
    place(prefix, "0.2.0", { layout_version: 2 });
    const message = unavailable(resolveShellBoot({ launcher }));
    expect(message).toBe(packageMissingMessage(BUILD));
    expect(message).toContain(BUILD);
    expect(message).toContain("Run the Vera installer again");
    expect(existsSync(desktopPackageReferencesDirectory(prefix))).toBe(false);
});

test("@core a package that needs a newer shell API is refused and nothing is held", () => {
    const { prefix, launcher } = install();
    place(prefix, "0.1.0");
    place(prefix, "0.2.0", { shell_api: 2 });
    expect(unavailable(resolveShellBoot({ launcher }))).toBe(shellTooOldMessage(BUILD));
    expect(existsSync(desktopPackageReferencesDirectory(prefix))).toBe(false);

    const accepted = resolveShellBoot({ launcher, shellApi: 2 });
    if (accepted.kind !== "package") throw new Error(unavailable(accepted));
    accepted.release();
    expect(accepted.package.desktopVersion).toBe("0.2.0");
    expect(accepted.package.shellApi).toBe(2);
});

test("a package whose manifest has no shell_api loads in a shell with API 1", () => {
    const { prefix, launcher } = install();
    place(prefix, "0.1.0");
    const manifestPath = join(desktopPackageDirectory(BUILD, "0.1.0", prefix), DESKTOP_PACKAGE_MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.shell_api;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const boot = resolveShellBoot({ launcher });
    if (boot.kind !== "package") throw new Error(unavailable(boot));
    boot.release();
    expect(boot.package.shellApi).toBe(1);
});

test("the notice page shows its message as text", () => {
    const page = noticePage("Build <b>x</b> & \"y\" is missing.");
    expect(page).toContain("Build &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot; is missing.");
    expect(page).not.toContain("<b>");
    expect(page).toContain("default-src 'none'");
});
