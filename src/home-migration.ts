import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { DEFAULT_PROFILE_NAME } from "./profile-paths.ts";

export const HOME_MIGRATION_RECEIPT_VERSION = 1;

export class HomeMigrationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HomeMigrationError";
    }
}

export type HomeMigrationPhase = "staging" | "swapping" | "active";

export interface HomeMigrationReceipt {
    readonly version: typeof HOME_MIGRATION_RECEIPT_VERSION;
    readonly phase: HomeMigrationPhase;
    readonly home: string;
    readonly staging: string;
    readonly backup: string;
    readonly startedAt: string;
    readonly defaultProfile: string;
    readonly otherProfiles: readonly string[];
    readonly unknownEntries: readonly string[];
}

export interface HomeMigrationHooks {
    readonly afterStagingBuilt?: () => void;
    readonly afterHomeRenamedToBackup?: () => void;
}

export interface HomeMigrationResult {
    readonly status: "migrated" | "already_flat" | "resumed" | "rolled_back";
    readonly home: string;
    readonly backup?: string;
    readonly otherProfiles: readonly string[];
    readonly unknownEntries: readonly string[];
}

export function homeMigrationReceiptPath(home: string): string {
    return `${home}.migration-receipt.json`;
}

export function homeMigrationStagingPath(home: string): string {
    return `${home}.next`;
}

export function readHomeMigrationReceipt(
    home: string,
): HomeMigrationReceipt | undefined {
    const path = homeMigrationReceiptPath(home);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isHomeMigrationReceipt(value) || value.home !== home) {
        throw new HomeMigrationError(
            `Damaged migration receipt at ${path}. Restore the previous home `
            + `from a sibling ${basename(home)}.bak-* directory if one exists.`,
        );
    }
    return value;
}

export function migrateHome(
    home: string,
    options: {
        readonly now?: () => Date;
        readonly hooks?: HomeMigrationHooks;
    } = {},
): HomeMigrationResult {
    const existing = readHomeMigrationReceipt(home);
    if (existing !== undefined) {
        return resumeHomeMigration(existing, options.hooks);
    }
    if (!existsSync(join(home, "profiles"))) {
        return {
            status: "already_flat",
            home,
            otherProfiles: [],
            unknownEntries: [],
        };
    }
    const defaultRoot = join(home, "profiles", DEFAULT_PROFILE_NAME);
    if (!existsSync(defaultRoot) || !lstatSync(defaultRoot).isDirectory()) {
        throw new HomeMigrationError(
            `${home} has profiles/ but no ${DEFAULT_PROFILE_NAME} profile to promote.`,
        );
    }
    const otherProfiles = listDirectoryNames(join(home, "profiles"))
        .filter((name) => name !== DEFAULT_PROFILE_NAME);
    const unknownEntries = listDirectoryNames(home)
        .filter((name) => name !== "profiles" && name !== "machine");
    const startedAt = (options.now ?? (() => new Date))().toISOString();
    const backup = `${home}.bak-${backupStamp(startedAt)}`;
    const staging = homeMigrationStagingPath(home);
    const receipt: HomeMigrationReceipt = {
        version: HOME_MIGRATION_RECEIPT_VERSION,
        phase: "staging",
        home,
        staging,
        backup,
        startedAt,
        defaultProfile: DEFAULT_PROFILE_NAME,
        otherProfiles,
        unknownEntries,
    };
    writeReceipt(receipt);
    return finishMigration(receipt, options.hooks);
}

export function rollbackHomeMigration(home: string): HomeMigrationResult {
    const receipt = readHomeMigrationReceipt(home);
    if (receipt === undefined) {
        throw new HomeMigrationError(
            `No migration receipt at ${homeMigrationReceiptPath(home)}.`,
        );
    }
    if (receipt.phase === "staging") {
        removeIfExists(receipt.staging);
        removeIfExists(homeMigrationReceiptPath(home));
        if (!existsSync(home)) {
            throw new HomeMigrationError(
                `${home} is missing and there is no backup to restore.`,
            );
        }
        return {
            status: "rolled_back",
            home,
            otherProfiles: receipt.otherProfiles,
            unknownEntries: receipt.unknownEntries,
        };
    }
    restoreBackup(receipt);
    return {
        status: "rolled_back",
        home: receipt.home,
        backup: receipt.backup,
        otherProfiles: receipt.otherProfiles,
        unknownEntries: receipt.unknownEntries,
    };
}

function resumeHomeMigration(
    receipt: HomeMigrationReceipt,
    hooks?: HomeMigrationHooks,
): HomeMigrationResult {
    if (receipt.phase === "active") {
        if (existsSync(join(receipt.home, "profiles"))) {
            throw new HomeMigrationError(
                `${receipt.home} still has profiles/ after a finished migration.`,
            );
        }
        return {
            status: "already_flat",
            home: receipt.home,
            backup: receipt.backup,
            otherProfiles: receipt.otherProfiles,
            unknownEntries: receipt.unknownEntries,
        };
    }
    return {
        ...finishMigration(receipt, hooks),
        status: "resumed",
    };
}

function finishMigration(
    receipt: HomeMigrationReceipt,
    hooks?: HomeMigrationHooks,
): HomeMigrationResult {
    if (receipt.phase === "staging") {
        buildStaging(receipt);
        hooks?.afterStagingBuilt?.();
        writeReceipt({ ...receipt, phase: "swapping" });
        receipt = { ...receipt, phase: "swapping" };
    }
    if (receipt.phase === "swapping") {
        completeSwap(receipt, hooks);
        writeReceipt({ ...receipt, phase: "active" });
        receipt = { ...receipt, phase: "active" };
    }
    assertNewHomeActive(receipt);
    return {
        status: "migrated",
        home: receipt.home,
        backup: receipt.backup,
        otherProfiles: receipt.otherProfiles,
        unknownEntries: receipt.unknownEntries,
    };
}

function buildStaging(receipt: HomeMigrationReceipt): void {
    removeIfExists(receipt.staging);
    mkdirSync(receipt.staging, { recursive: true, mode: 0o700 });
    const defaultRoot = join(
        receipt.home,
        "profiles",
        receipt.defaultProfile,
    );
    for (const name of listDirectoryNames(defaultRoot)) {
        copyPreservingSymlinks(
            join(defaultRoot, name),
            join(receipt.staging, name),
        );
    }
    const machine = join(receipt.home, "machine");
    if (existsSync(machine)) {
        copyPreservingSymlinks(machine, join(receipt.staging, "machine"));
    }
    rewriteLiftedHomePaths(receipt.staging, receipt.home);
}

function completeSwap(
    receipt: HomeMigrationReceipt,
    hooks?: HomeMigrationHooks,
): void {
    if (newHomeLooksActive(receipt.home) && existsSync(receipt.backup)) {
        removeIfExists(receipt.staging);
        return;
    }
    if (existsSync(receipt.home) && existsSync(join(receipt.home, "profiles"))) {
        if (existsSync(receipt.backup)) {
            throw new HomeMigrationError(
                `Backup already exists at ${receipt.backup}.`,
            );
        }
        renameSync(receipt.home, receipt.backup);
        hooks?.afterHomeRenamedToBackup?.();
    }
    if (!existsSync(receipt.home)) {
        if (!existsSync(receipt.staging)) {
            if (existsSync(receipt.backup)) {
                renameSync(receipt.backup, receipt.home);
            }
            throw new HomeMigrationError(
                `Staging is missing at ${receipt.staging}. Restored the previous home.`,
            );
        }
        renameSync(receipt.staging, receipt.home);
    }
    removeIfExists(receipt.staging);
}

function restoreBackup(receipt: HomeMigrationReceipt): void {
    if (existsSync(receipt.home) && existsSync(join(receipt.home, "profiles"))) {
        removeIfExists(receipt.staging);
        removeIfExists(homeMigrationReceiptPath(receipt.home));
        return;
    }
    if (!existsSync(receipt.backup)) {
        throw new HomeMigrationError(
            `Backup is missing at ${receipt.backup}. The new home is still at ${receipt.home}.`,
        );
    }
    const leftover = homeMigrationStagingPath(receipt.home);
    if (existsSync(receipt.home)) {
        removeIfExists(leftover);
        renameSync(receipt.home, leftover);
    }
    renameSync(receipt.backup, receipt.home);
    removeIfExists(leftover);
    removeIfExists(homeMigrationReceiptPath(receipt.home));
}

function assertNewHomeActive(receipt: HomeMigrationReceipt): void {
    if (!existsSync(receipt.home)) {
        throw new HomeMigrationError(`${receipt.home} is missing after migration.`);
    }
    if (existsSync(join(receipt.home, "profiles"))) {
        throw new HomeMigrationError(
            `${receipt.home} still has profiles/. Migration did not finish.`,
        );
    }
    if (!existsSync(receipt.backup)) {
        throw new HomeMigrationError(`Backup is missing at ${receipt.backup}.`);
    }
    for (const name of receipt.otherProfiles) {
        if (existsSync(join(receipt.home, name)) && name !== "machine") {
            const defaultHad = existsSync(
                join(receipt.backup, "profiles", receipt.defaultProfile, name),
            );
            if (!defaultHad) {
                throw new HomeMigrationError(
                    `${name} from another profile reached the live home.`,
                );
            }
        }
        if (!existsSync(join(receipt.backup, "profiles", name))) {
            throw new HomeMigrationError(
                `Profile ${name} is missing from backup ${receipt.backup}.`,
            );
        }
    }
}

function newHomeLooksActive(home: string): boolean {
    return existsSync(home) && !existsSync(join(home, "profiles"));
}

function rewriteLiftedHomePaths(staging: string, home: string): void {
    const prefix = join(home, "profiles", DEFAULT_PROFILE_NAME);
    const path = join(staging, "config.json");
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    if (!text.includes(prefix)) return;
    writeFileSync(path, text.split(prefix).join(home));
}

function copyPreservingSymlinks(from: string, to: string): void {
    cpSync(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
    });
}

function writeReceipt(receipt: HomeMigrationReceipt): void {
    const path = homeMigrationReceiptPath(receipt.home);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 4)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    renameSync(temporary, path);
}

function isHomeMigrationReceipt(value: unknown): value is HomeMigrationReceipt {
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record.version === HOME_MIGRATION_RECEIPT_VERSION
        && (record.phase === "staging"
            || record.phase === "swapping"
            || record.phase === "active")
        && typeof record.home === "string"
        && typeof record.staging === "string"
        && typeof record.backup === "string"
        && typeof record.startedAt === "string"
        && typeof record.defaultProfile === "string"
        && Array.isArray(record.otherProfiles)
        && Array.isArray(record.unknownEntries);
}

function listDirectoryNames(path: string): readonly string[] {
    if (!existsSync(path)) return [];
    return readdirSync(path)
        .filter((name) => !name.startsWith("."))
        .sort();
}

function backupStamp(iso: string): string {
    return iso.replaceAll(/[:.]/g, "-");
}

function removeIfExists(path: string): void {
    rmSync(path, { recursive: true, force: true });
}
