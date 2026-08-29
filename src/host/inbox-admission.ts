import {
    existsSync,
    mkdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import {
    defaultVeraConfigPath,
    updateVeraConfigDefaults,
    type VeraConfig,
} from "../config.ts";
import type { InboxEntry } from "../store/inbox.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

/** Source-family names are the stable, narrow part of an event kind. */
export const INBOX_SOURCE_FAMILY_PATTERN = /^[a-z][a-z0-9_-]*$/;

export type InboxAdmissionScope = "user" | "project";

export interface InboxAdmissionPolicyOptions {
    readonly user: readonly string[];
    readonly projectRoot?: string;
    readonly project?: readonly string[];
    readonly userConfigPath?: string;
}

/**
 * The durable half of inbox admission. Project entries extend user entries;
 * there is deliberately no remove or wildcard operation here, so a project
 * cannot weaken a user's choice and an event cannot choose its own scope.
 */
export class InboxAdmissionPolicy {
    private readonly user = new Set<string>();
    private readonly project = new Set<string>();
    private readonly projectRoot: string | undefined;
    private readonly userConfigPath: string;

    constructor(options: InboxAdmissionPolicyOptions) {
        addFamilies(this.user, options.user);
        addFamilies(
            this.project,
            options.project
                ?? (options.projectRoot === undefined
                    ? []
                    : loadProjectInboxAdmission(options.projectRoot)),
        );
        this.projectRoot = options.projectRoot;
        this.userConfigPath = options.userConfigPath
            ?? defaultVeraConfigPath();
    }

    static fromConfig(
        config: Pick<VeraConfig, "inbox">,
        projectRoot?: string,
        userConfigPath?: string,
    ): InboxAdmissionPolicy {
        return new InboxAdmissionPolicy({
            user: config.inbox?.admit ?? [],
            ...(projectRoot === undefined ? {} : { projectRoot }),
            ...(userConfigPath === undefined ? {} : { userConfigPath }),
        });
    }

    allows(sourceFamily: string): boolean {
        this.refreshFromDisk();
        return this.user.has(sourceFamily) || this.project.has(sourceFamily);
    }

    canRemember(scope: InboxAdmissionScope): boolean {
        return scope === "user" || this.projectRoot !== undefined;
    }

    userFamilies(): readonly string[] {
        this.refreshFromDisk();
        return [...this.user];
    }

    projectFamilies(): readonly string[] {
        this.refreshFromDisk();
        return [...this.project];
    }

    /** Persists and then activates an always rule. */
    remember(
        sourceFamily: string,
        scope: InboxAdmissionScope,
    ): Promise<void> {
        assertSourceFamily(sourceFamily);
        if (!this.canRemember(scope)) {
            return Promise.reject(
                new Error("Project inbox admission is unavailable without a workspace"),
            );
        }
        const path = scope === "user"
            ? this.userConfigPath
            : this.projectRoot === undefined
                ? undefined
                : projectInboxConfigPath(this.projectRoot);
        if (path === undefined) {
            return Promise.reject(
                new Error("Project inbox admission is unavailable without a workspace"),
            );
        }

        return enqueueAdmissionWrite(path, () => {
            if (scope === "user") {
                const current = readUserInboxAdmission(this.userConfigPath)
                    ?? [...this.user];
                const next = uniqueFamilies([...current, sourceFamily]);
                updateVeraConfigDefaults({
                    inbox: { admit: next },
                }, { path: this.userConfigPath });
                replaceSet(this.user, next);
                return;
            }

            const projectRoot = this.projectRoot;
            if (projectRoot === undefined) {
                throw new Error(
                    "Project inbox admission is unavailable without a workspace",
                );
            }
            const next = writeProjectInboxAdmission(projectRoot, sourceFamily);
            replaceSet(this.project, next);
        });
    }

    private refreshFromDisk(): void {
        const user = readUserInboxAdmission(this.userConfigPath);
        if (user !== undefined) replaceSet(this.user, user);
        if (this.projectRoot !== undefined) {
            replaceSet(
                this.project,
                loadProjectInboxAdmission(this.projectRoot),
            );
        }
    }
}

const admissionWriteLocks = new Map<string, Promise<void>>();

function enqueueAdmissionWrite(
    path: string,
    write: () => void,
): Promise<void> {
    const previous = admissionWriteLocks.get(path) ?? Promise.resolve();
    const next = previous.then(write);
    admissionWriteLocks.set(path, next.catch(() => undefined));
    return next;
}

/** The family carried by a stored event, without reading its payload. */
export function inboxSourceFamily(entry: Pick<InboxEntry, "source" | "kind">): string {
    const kindSeparator = entry.kind.indexOf(".");
    if (kindSeparator > 0) {
        return entry.kind.slice(0, kindSeparator);
    }

    const source = entry.source.split("/")[0] ?? entry.source;
    const sourceSeparator = source.lastIndexOf(".");
    return sourceSeparator >= 0
        ? source.slice(sourceSeparator + 1)
        : source;
}

export function parseInboxAdmissionList(
    value: unknown,
): readonly string[] | undefined {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return undefined;
    const families = value.map((item) =>
        typeof item === "string" ? item.trim() : ""
    );
    if (
        families.some((family) => !INBOX_SOURCE_FAMILY_PATTERN.test(family))
        || new Set(families).size !== families.length
    ) {
        return undefined;
    }
    return families;
}

export function projectInboxConfigPath(projectRoot: string): string {
    return join(resolve(projectRoot), ".vera", "config.json");
}

export function loadProjectInboxAdmission(
    projectRoot: string,
): readonly string[] {
    const path = projectInboxConfigPath(projectRoot);
    if (!existsSync(path)) return [];

    let value: unknown;
    try {
        value = JSON.parse(readRegularFileTextSync(path));
    } catch {
        return [];
    }
    const raw = asRecord(value);
    const inbox = asRecord(raw?.inbox);
    return parseInboxAdmissionList(inbox?.admit) ?? [];
}

function writeProjectInboxAdmission(
    projectRoot: string,
    sourceFamily: string,
): readonly string[] {
    const path = projectInboxConfigPath(projectRoot);
    const raw = readJsonRecord(path);
    const currentInbox = raw.inbox === undefined
        ? {}
        : asRecord(raw.inbox);
    if (currentInbox === undefined) {
        throw new Error(`Project Vera config at ${path} has invalid inbox config`);
    }
    const current = currentInbox.admit === undefined
        ? []
        : parseInboxAdmissionList(currentInbox.admit);
    if (current === undefined) {
        throw new Error(`Project Vera config at ${path} has invalid inbox admission`);
    }
    const families = uniqueFamilies([...current, sourceFamily]);
    const next = {
        ...raw,
        inbox: {
            ...currentInbox,
            admit: [...families],
        },
    };
    const directory = dirname(path);
    const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
    });
    renameSync(temporaryPath, path);
    return families;
}

function readUserInboxAdmission(path: string): readonly string[] | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const raw = JSON.parse(readRegularFileTextSync(path));
        const record = asRecord(raw);
        const inbox = asRecord(record?.inbox);
        return parseInboxAdmissionList(inbox?.admit);
    } catch {
        return undefined;
    }
}

function readJsonRecord(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    let value: unknown;
    try {
        value = JSON.parse(readRegularFileTextSync(path));
    } catch {
        throw new Error(`Project Vera config at ${path} is not valid JSON`);
    }
    const record = asRecord(value);
    if (record === undefined) {
        throw new Error(`Project Vera config at ${path} must be an object`);
    }
    return record;
}

function addFamilies(target: Set<string>, families: readonly string[]): void {
    for (const family of families) {
        assertSourceFamily(family);
        target.add(family);
    }
}

function replaceSet(target: Set<string>, values: readonly string[]): void {
    target.clear();
    addFamilies(target, values);
}

function uniqueFamilies(families: readonly string[]): readonly string[] {
    return [...new Set(families)];
}

function assertSourceFamily(value: string): void {
    if (!INBOX_SOURCE_FAMILY_PATTERN.test(value)) {
        throw new Error(`Invalid inbox source family: ${value}`);
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
