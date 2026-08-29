/**
 * Reads the declarative pool file at both scopes and merges them.
 *
 * Merging is per field, not per document: a project file that names only
 * `deny` leaves the user's `subagent` and `allow` intact. Replacing a whole
 * section would make a project file that tightens one rule silently discard
 * every unrelated user setting.
 *
 * A missing file is not an error. An unreadable or malformed file yields an
 * empty contribution plus issues, so one broken scope never erases the other.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
    EMPTY_POOL_FILE,
    type LearnedFacts,
    type PoolFile,
    type PoolFileDefaults,
    type PoolFileIssue,
    type PoolFileModel,
    issueSeverity,
    parsePoolFileText,
} from "./pool-file.ts";
import { veraProfileDirectory } from "../profile-paths.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export type PoolScope = "user" | "project";

export interface ScopedPoolIssue extends PoolFileIssue {
    readonly scope: PoolScope;
    readonly path: string;
}

export interface LoadedPoolFile {
    readonly merged: PoolFile;
    readonly user: PoolFile;
    readonly project: PoolFile;
    readonly issues: readonly ScopedPoolIssue[];
}

export interface LoadPoolFileOptions {
    /** Overrides `~/.vera/pool.json`. */
    readonly userPath?: string;
    /** Overrides `<projectRoot>/.vera/pool.json`. */
    readonly projectPath?: string;
    /** Directory the project-scope file is looked for in. */
    readonly projectRoot?: string;
}

/**
 * One line per issue, for a client to show at startup.
 *
 * Non-blocking on purpose: a pool file with a bad entry still yields a pool,
 * and the alternative to saying so is a setting the user wrote and Vera never
 * applied. The scope is named because the same path can appear in two files.
 */
export function poolFileIssueNotices(
    issues: readonly ScopedPoolIssue[],
): readonly string[] {
    return issues.map((issue) => {
        const where = issue.path === ""
            ? `${issue.scope} pool file`
            : `${issue.scope} pool file at ${issue.path}`;
        return issueSeverity(issue) === "warning"
            ? `Pool warning: ${where}: ${issue.message}`
            : `Pool error: ${where}: ${issue.message}`;
    });
}

/**
 * A test run gets a scratch file per process instead of the developer's own
 * pool. A test that resolves this path without meaning to would otherwise
 * write entries into that pool for the developer to find and delete by hand.
 * `VERA_POOL_FILE` points the path somewhere chosen, test run or not.
 */
export function userPoolFilePath(): string {
    const override = process.env.VERA_POOL_FILE;
    if (override !== undefined && override.length > 0) {
        return override;
    }
    if (process.env.NODE_ENV === "test") {
        return join(tmpdir(), "vera-test-pool", `${process.pid}.json`);
    }
    return join(veraProfileDirectory(), "pool.json");
}

export function projectPoolFilePath(projectRoot: string): string {
    return join(projectRoot, ".vera", "pool.json");
}

export function loadPoolFile(
    options: LoadPoolFileOptions = {},
): LoadedPoolFile {
    const issues: ScopedPoolIssue[] = [];
    const user = readScope(
        options.userPath ?? userPoolFilePath(),
        "user",
        issues,
    );
    const projectPath = options.projectPath
        ?? (options.projectRoot === undefined
            ? undefined
            : projectPoolFilePath(options.projectRoot));
    const project = projectPath === undefined
        ? EMPTY_POOL_FILE
        : readScope(projectPath, "project", issues);

    return { merged: mergePoolFiles(user, project), user, project, issues };
}

/** `over` wins field by field; anything it omits keeps `under`'s value. */
export function mergePoolFiles(under: PoolFile, over: PoolFile): PoolFile {
    const models: Record<string, PoolFileModel> = { ...under.models };
    for (const [id, entry] of Object.entries(over.models)) {
        const existing = under.models[id];
        models[id] = existing === undefined
            ? entry
            : mergeModel(existing, entry);
    }

    return {
        defaults: mergeDefaults(under.defaults, over.defaults),
        models,
    };
}

function mergeDefaults(
    under: PoolFileDefaults,
    over: PoolFileDefaults,
): PoolFileDefaults {
    return {
        ...under,
        ...over,
    };
}

/**
 * Effort and learned maps merge key by key so a project file can forbid one
 * level without redeclaring the rest of the ladder. `fallback` is a single
 * ordered decision, so the project list replaces the user's outright.
 */
function mergeModel(
    under: PoolFileModel,
    over: PoolFileModel,
): PoolFileModel {
    const efforts = mergeRecord(under.efforts, over.efforts);
    const learned = mergeRecord(
        under.learned,
        over.learned,
    ) as LearnedFacts | undefined;
    return {
        ...under,
        ...over,
        ...(efforts === undefined ? {} : { efforts }),
        ...(learned === undefined ? {} : { learned }),
    };
}

function mergeRecord<T>(
    under: Readonly<Record<string, T>> | undefined,
    over: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> | undefined {
    if (under === undefined) {
        return over;
    }
    if (over === undefined) {
        return under;
    }
    return { ...under, ...over };
}

function readScope(
    path: string,
    scope: PoolScope,
    issues: ScopedPoolIssue[],
): PoolFile {
    let text: string;
    try {
        text = readRegularFileTextSync(path);
    } catch {
        return EMPTY_POOL_FILE;
    }
    const parsed = parsePoolFileText(text);
    for (const issue of parsed.issues) {
        issues.push({ ...issue, scope });
    }
    return parsed.file;
}
