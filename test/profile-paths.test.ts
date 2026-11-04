import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defaultVeraConfigPath } from "../src/config.ts";
import { eventLogRoot } from "../src/engine/events.ts";
import { defaultPermissionPreferencesPath } from "../src/engine/permission-preferences.ts";
import { defaultReviewLogPath } from "../src/engine/review-log.ts";
import { extensionRegistryPathFor } from "../src/extensions/manager.ts";
import { defaultHostLogPath } from "../src/host/host-log.ts";
import { defaultSpawnConsentPath } from "../src/host/inbox-spawn.ts";
import {
    defaultHostLockPath,
    defaultHostSocketPath,
} from "../src/host/lockfile.ts";
import { defaultTrustNoticePath } from "../src/host/trust-notice.ts";
import { providerCatalogCacheDir } from "../src/model/catalog-cache.ts";
import { curatedCachePath } from "../src/model/curated-models.ts";
import { defaultAuthStoragePath } from "../src/providers/auth-storage.ts";
import { defaultSchedulePath } from "../src/scheduler/store.ts";
import { defaultInboxPath } from "../src/store/inbox.ts";
import { defaultModelFailureLedgerPath } from "../src/store/model-failures.ts";
import { defaultSessionDirectory } from "../src/store/session-store.ts";
import {
    assertProfileLayout,
    legacyLayoutEntries,
    unrecognisedHomeEntries,
    VeraProfileError,
    veraProfileDirectory,
    veraRuntimeDirectory,
    veraMachineDirectory,
    veraHomeDirectory,
} from "../src/profile-paths.ts";

const home = "/home/nash";

test("the home is one directory, not a profile child", () => {
    expect(veraHomeDirectory(home)).toBe(join(home, ".vera"));
    expect(veraProfileDirectory({}, home)).toBe(join(home, ".vera"));
    expect(veraRuntimeDirectory({}, home)).toBe(join(home, ".vera", "runtime"));
});

test("credentials sit in the machine tier beside config", () => {
    expect(veraMachineDirectory(home)).toBe(join(home, ".vera", "machine"));
});

test("runtime is always the home child, not a second island", () => {
    expect(veraRuntimeDirectory({ VERA_HOME: "/tmp/other" }, home))
        .toBe(join(home, ".vera", "runtime"));
});

test("an unmigrated profiles/ home is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "profiles", "default"), { recursive: true });

    expect(legacyLayoutEntries(root)).toEqual(["profiles"]);
    expect(() => assertProfileLayout(root)).toThrow(VeraProfileError);
    try {
        assertProfileLayout(root);
    } catch (error) {
        expect((error as Error).message).toContain("profiles/");
        expect((error as Error).message).toContain("vera migrate-home");
    }
});

test("the old machine-tier name is refused with the rename to run", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "user"), { recursive: true });
    expect(() => assertProfileLayout(root)).toThrow(VeraProfileError);
    try {
        assertProfileLayout(root);
    } catch (error) {
        expect((error as Error).message).toContain(veraMachineDirectory(root));
    }
});

test("a single-home layout is accepted", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "machine"), { recursive: true });
    mkdirSync(join(root, ".vera", "runtime"), { recursive: true });
    writeFileSync(join(root, ".vera", "config.json"), "{}");
    expect(legacyLayoutEntries(root)).toEqual([]);
    expect(() => assertProfileLayout(root)).not.toThrow();
});

test("tip history at the home root is owned, not leftover", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera"), { recursive: true });
    writeFileSync(join(root, ".vera", "tips.json"), "{}");
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("spawn consent and standing nudges at the home root are owned", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera"), { recursive: true });
    writeFileSync(join(root, ".vera", "spawn-consent.json"), "{}");
    writeFileSync(join(root, ".vera", "standing-nudges.json"), "{}");
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("the extension registry the installer writes is owned", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "extensions"), { recursive: true });
    writeFileSync(
        extensionRegistryPathFor({ home: root }),
        "{}",
    );
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("state written outside the known root names is named", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "machine"), { recursive: true });
    mkdirSync(join(root, ".vera", "runtime"), { recursive: true });
    expect(unrecognisedHomeEntries(root)).toEqual([]);

    mkdirSync(join(root, ".vera", "chrome"));
    writeFileSync(join(root, ".vera", "tui.json"), "{}");
    writeFileSync(join(root, ".vera", "tips.json"), "{}");
    writeFileSync(join(root, ".vera", ".DS_Store"), "");
    expect(unrecognisedHomeEntries(root)).toEqual(["chrome"]);
});

test("extension data under extension-data is owned", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "extension-data", "vera.chrome"), {
        recursive: true,
    });
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("a stray directory named like an installed extension is unrecognised", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "extensions", "chrome"), { recursive: true });
    writeFileSync(
        join(root, ".vera", "extensions", "chrome", "vera.extension.json"),
        JSON.stringify({ id: "vera.chrome", version: "1.0.0" }),
    );
    mkdirSync(join(root, ".vera", "vera.chrome"));
    expect(unrecognisedHomeEntries(root)).toEqual(["vera.chrome"]);
});

test("a stray directory named like a managed extension is unrecognised", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    mkdirSync(join(root, ".vera", "extensions", ".managed"), { recursive: true });
    writeFileSync(
        join(root, ".vera", "extensions", ".managed", "vera.btw.json"),
        "{}",
    );
    mkdirSync(join(root, ".vera", "vera.btw"));
    expect(unrecognisedHomeEntries(root)).toEqual(["vera.btw"]);
});

test("a home that does not exist yet has nothing to complain about", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    expect(unrecognisedHomeEntries(root)).toEqual([]);
});

test("every path helper accepts one selected home", () => {
    const veraHome = mkdtempSync(join(tmpdir(), "vera-selected-home-"));
    const helpers: readonly [
        string,
        (home?: string) => string,
        string,
    ][] = [
        ["defaultSessionDirectory", defaultSessionDirectory, "runtime/sessions"],
        ["defaultHostSocketPath", defaultHostSocketPath, "runtime/host.sock"],
        ["defaultHostLockPath", defaultHostLockPath, "runtime/host.json"],
        ["defaultInboxPath", defaultInboxPath, "runtime/inbox.db"],
        ["defaultSchedulePath", defaultSchedulePath, "runtime/schedules.db"],
        ["defaultHostLogPath", defaultHostLogPath, "runtime/logs/host.jsonl"],
        [
            "defaultReviewLogPath",
            defaultReviewLogPath,
            "runtime/logs/reviewer.jsonl",
        ],
        ["defaultVeraConfigPath", defaultVeraConfigPath, "config.json"],
        [
            "defaultModelFailureLedgerPath",
            defaultModelFailureLedgerPath,
            "runtime/failures/ledger.jsonl",
        ],
        ["defaultAuthStoragePath", defaultAuthStoragePath, "machine/auth.json"],
        [
            "defaultPermissionPreferencesPath",
            defaultPermissionPreferencesPath,
            "preferences.json",
        ],
        ["defaultTrustNoticePath", defaultTrustNoticePath, "trust-notices.json"],
        ["defaultSpawnConsentPath", defaultSpawnConsentPath, "spawn-consent.json"],
        ["providerCatalogCacheDir", providerCatalogCacheDir, "runtime/cache"],
        ["curatedCachePath", curatedCachePath, "runtime/curated-models.json"],
        ["eventLogRoot", eventLogRoot, "runtime/logs"],
    ];
    const resolved = (home?: string): Record<string, string> =>
        Object.fromEntries(helpers.map(([name, helper]) => [name, helper(home)]));
    const expectedIn = (root: string): Record<string, string> =>
        Object.fromEntries(helpers.map(([name, , suffix]) => [
            name,
            join(root, ...suffix.split("/")),
        ]));

    const saved = process.env.VERA_HOME;
    try {
        delete process.env.VERA_HOME;
        const defaultHome = join(homedir(), ".vera");
        expect(resolved()).toEqual(expectedIn(defaultHome));
        expect(resolved(veraHome)).toEqual(expectedIn(veraHome));

        process.env.VERA_HOME = veraHome;
        expect(resolved()).toEqual(expectedIn(veraHome));
        expect(resolved(veraHome)).toEqual(expectedIn(veraHome));
    } finally {
        if (saved === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = saved;
    }
});
