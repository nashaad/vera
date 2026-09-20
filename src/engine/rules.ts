import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { veraProfileDirectory } from "../profile-paths.ts";

export const RULES_DIR_NAME = "rules";

const MAX_RULE_BYTES = 128 * 1024;
const MAX_ALWAYS_ON_BYTES = 256 * 1024;

export type RuleScope = "user" | "project";

export interface Rule {
    readonly scope: RuleScope;
    readonly path: string;
    readonly displayPath: string;
    /** Empty means the rule is always on and loads at session start. */
    readonly paths: readonly string[];
    readonly body: string;
}

export interface RuleSnapshot {
    readonly rules: readonly Rule[];
    readonly warnings: readonly string[];
}

/** Defaulted from the home; passed explicitly by callers that must not read the real home. */
export interface RuleDirectories {
    readonly user: string;
    readonly project: string;
}

export function userRulesDir(): string {
    return join(veraProfileDirectory(), RULES_DIR_NAME);
}

export function projectRulesDir(workspace: string): string {
    return join(workspace, ".vera", RULES_DIR_NAME);
}

export function ruleDirectories(workspace: string): RuleDirectories {
    return { user: userRulesDir(), project: projectRulesDir(workspace) };
}

export async function loadRules(
    directories: RuleDirectories,
): Promise<RuleSnapshot> {
    const rules: Rule[] = [];
    const warnings: string[] = [];
    for (const scope of ["user", "project"] as const) {
        const loaded = await loadScope(scope, directories[scope], warnings);
        rules.push(...loaded);
    }
    return { rules, warnings };
}

export function alwaysOnRules(
    rules: readonly Rule[],
    scope: RuleScope,
): readonly Rule[] {
    const chosen: Rule[] = [];
    let total = 0;
    for (const rule of rules) {
        if (rule.scope !== scope || rule.paths.length > 0) {
            continue;
        }
        total += Buffer.byteLength(rule.body, "utf8");
        if (total > MAX_ALWAYS_ON_BYTES) {
            break;
        }
        chosen.push(rule);
    }
    return chosen;
}

export function rulesForReadPaths(
    rules: readonly Rule[],
    workspace: string,
    readPaths: readonly string[],
    alreadyInjected: ReadonlySet<string>,
): readonly Rule[] {
    const relatives = readPaths
        .map((path) => workspaceRelativePath(workspace, path))
        .filter((path): path is string => path !== undefined);
    if (relatives.length === 0) {
        return [];
    }
    return rules.filter((rule) =>
        rule.paths.length > 0
        && !alreadyInjected.has(rule.path)
        && rule.paths.some((glob) =>
            relatives.some((relativePath) => globMatches(glob, relativePath))
        )
    );
}

export function formatRuleReminder(rules: readonly Rule[]): string {
    // Trailing newlines are stripped so two rules join as one blank line.
    return rules
        .map((rule) =>
            `Contents of ${rule.displayPath}:\n\n${rule.body.replace(/\n+$/, "")}`
        )
        .join("\n\n");
}

export function globMatches(glob: string, relativePath: string): boolean {
    const pattern = posixPath(glob);
    const value = posixPath(relativePath);
    if (pattern.length === 0 || value.length === 0) {
        return false;
    }
    return globRegExp(pattern).test(value);
}

export function workspaceRelativePath(
    workspace: string,
    path: string,
): string | undefined {
    const resolved = isAbsolute(path) ? path : join(workspace, path);
    const rel = relative(workspace, resolved);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
        return undefined;
    }
    return posixPath(rel);
}

async function loadScope(
    scope: RuleScope,
    dir: string,
    warnings: string[],
): Promise<readonly Rule[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch (error) {
        if (!isMissingFile(error)) {
            warnings.push(`${dir} could not be read, so no ${scope} rules were loaded`);
        }
        return [];
    }
    const files = names
        .filter((name) => name.toLowerCase().endsWith(".md"))
        .sort((left, right) => left.localeCompare(right));
    const rules: Rule[] = [];
    for (const name of files) {
        const rule = await loadRule(scope, dir, name, warnings);
        if (rule !== undefined) {
            rules.push(rule);
        }
    }
    return rules;
}

async function loadRule(
    scope: RuleScope,
    dir: string,
    name: string,
    warnings: string[],
): Promise<Rule | undefined> {
    const path = join(dir, name);
    let text: string;
    try {
        const details = await stat(path);
        if (!details.isFile()) {
            return undefined;
        }
        if (details.size > MAX_RULE_BYTES) {
            warnings.push(`${displayPathFor(scope, name)} is larger than 128 KB, so it was skipped`);
            return undefined;
        }
        const bytes = await readFile(path);
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        warnings.push(`${displayPathFor(scope, name)} could not be read, so it was skipped`);
        return undefined;
    }
    const parsed = parseRule(text);
    if (parsed === undefined) {
        warnings.push(
            `${displayPathFor(scope, name)} has frontmatter that is not a paths list, so it was skipped`,
        );
        return undefined;
    }
    return {
        scope,
        path,
        displayPath: displayPathFor(scope, basename(path)),
        paths: parsed.paths,
        body: parsed.body,
    };
}

function displayPathFor(scope: RuleScope, name: string): string {
    const root = scope === "user" ? "<home>" : ".vera";
    return `${root}/${RULES_DIR_NAME}/${name}`;
}

interface ParsedRule {
    readonly paths: readonly string[];
    readonly body: string;
}

function parseRule(text: string): ParsedRule | undefined {
    const stripped = text.startsWith("﻿") ? text.slice(1) : text;
    if (!stripped.startsWith("---")) {
        return { paths: [], body: stripped };
    }
    const end = stripped.indexOf("\n---", 3);
    if (end === -1) {
        return { paths: [], body: stripped };
    }
    const frontmatter = stripped.slice(stripped.indexOf("\n") + 1, end + 1);
    const afterFence = stripped.indexOf("\n", end + 1);
    const body = afterFence === -1 ? "" : stripped.slice(afterFence + 1);
    let parsed: unknown;
    try {
        parsed = Bun.YAML.parse(frontmatter);
    } catch {
        return undefined;
    }
    const paths = parsePaths(parsed);
    if (paths === undefined) {
        return undefined;
    }
    return { paths, body: body.replace(/^\n+/, "") };
}

/** Unknown frontmatter keys are ignored: a later trigger is a new key, not a new format. */
function parsePaths(value: unknown): readonly string[] | undefined {
    if (value === null || value === undefined) {
        return [];
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const raw = (value as { readonly paths?: unknown }).paths;
    if (raw === undefined || raw === null) {
        return [];
    }
    if (typeof raw === "string") {
        const glob = raw.trim();
        return glob.length === 0 ? undefined : [glob];
    }
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const globs: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string" || item.trim().length === 0) {
            return undefined;
        }
        globs.push(item.trim());
    }
    return globs;
}

function globRegExp(glob: string): RegExp {
    let pattern = "";
    for (let index = 0; index < glob.length;) {
        if (glob.startsWith("**/", index)) {
            pattern += "(?:.*/)?";
            index += 3;
            continue;
        }
        if (glob.startsWith("**", index) && index + 2 === glob.length) {
            pattern += ".*";
            index += 2;
            continue;
        }
        const char = glob[index]!;
        if (char === "*") {
            pattern += "[^/]*";
        } else if (char === "?") {
            pattern += "[^/]";
        } else {
            pattern += escapeRegExp(char);
        }
        index += 1;
    }
    return new RegExp(`^${pattern}$`);
}

function escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function posixPath(path: string): string {
    return path.split(sep).join("/");
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
