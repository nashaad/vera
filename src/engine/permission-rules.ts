import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import { permissionPredicateMatches } from "./permission-grants.ts";
import { canonicalPermissionPath } from "./workspace-scope.ts";
import type {
    PermissionAction,
    PermissionRule,
} from "./permissions.ts";

// Expands a leading `~` and normalizes `..`. A relative path is a config problem,
// so it returns undefined for the caller to report.
export function normalizePermissionRulePath(
    value: string,
    home: string = homedir(),
): string | undefined {
    const expanded = value === "~"
        ? home
        : value.startsWith("~/")
            ? resolve(home, value.slice(2))
            : value;
    return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

export function permissionRulePathMatches(
    rulePath: string,
    actionPath: string,
    home: string = homedir(),
    foldCase = false,
): boolean {
    const normalizedRule = normalizePermissionRulePath(rulePath, home);
    if (normalizedRule === undefined || !isAbsolute(actionPath)) {
        return false;
    }
    const ruleForms = [normalizedRule, canonicalPermissionPath(normalizedRule)];
    const actionForms = [
        resolve(actionPath),
        canonicalPermissionPath(actionPath),
    ];
    return ruleForms.some((rule) =>
        actionForms.some((action) => containsPath(rule, action, foldCase))
    );
}

// The words before a command do not always give the action a path, so a bash
// deny or ask on a path also reads the command text. Only literal spellings are
// seen: a path built from a variable or a command substitution is not.
export function commandNamesPermissionPath(
    command: string,
    rulePath: string,
    home: string = homedir(),
    foldCase = false,
): boolean {
    const normalized = normalizePermissionRulePath(rulePath, home);
    if (normalized === undefined) return false;
    const candidateForms = [normalized, canonicalPermissionPath(normalized)];
    for (const raw of command.split(/[\s;&|<>()`'"]+/)) {
        for (const candidate of wordCandidates(raw)) {
            const expanded = expandCommandWord(candidate, home);
            if (expanded === undefined) continue;
            const forms = [expanded, canonicalPermissionPath(expanded)];
            if (
                candidateForms.some((rule) =>
                    forms.some((form) => containsPath(rule, form, foldCase))
                )
            ) {
                return true;
            }
        }
    }
    return false;
}

// An allow matches only the action's own path. The command text check exists
// for deny and ask, because bash does not extract a path for every read.
export function permissionRuleMatches(
    rule: PermissionRule,
    action: PermissionAction,
    options: {
        readonly command?: string;
        readonly home?: string;
    } = {},
): boolean {
    const predicate = rule.when;
    if (predicate.path === undefined) {
        return permissionPredicateMatches(predicate, action);
    }
    const { path: _path, ...withoutPath } = predicate;
    if (!permissionPredicateMatches(withoutPath, action)) {
        return false;
    }
    const home = options.home ?? homedir();
    // A folder that does not exist yet keeps the case it was typed in, so a
    // deny or ask ignores case on macOS. An allow stays exact.
    const foldCase = rule.then !== "allow" && process.platform === "darwin";
    if (
        action.path !== undefined
        && permissionRulePathMatches(predicate.path, action.path, home, foldCase)
    ) {
        return true;
    }
    return rule.then !== "allow"
        && options.command !== undefined
        && action.tool === "bash"
        && commandNamesPermissionPath(
            options.command,
            predicate.path,
            home,
            foldCase,
        );
}

function containsPath(
    rule: string,
    action: string,
    foldCase: boolean,
): boolean {
    const foldedRule = foldCase ? rule.toLowerCase() : rule;
    const foldedAction = foldCase ? action.toLowerCase() : action;
    return foldedAction === foldedRule
        || foldedAction.startsWith(`${foldedRule}${sep}`);
}

function wordCandidates(word: string): readonly string[] {
    const trimmed = word.replace(/^[({]+/, "").replace(/[)},;]+$/, "");
    const assigned = trimmed.indexOf("=");
    return assigned > 0 && assigned < trimmed.length - 1
        ? [trimmed, trimmed.slice(assigned + 1)]
        : [trimmed];
}

function expandCommandWord(
    word: string,
    home: string,
): string | undefined {
    if (word === "~" || word === "$HOME" || word === "${HOME}") {
        return home;
    }
    if (word.startsWith("~/")) return resolve(home, word.slice(2));
    if (word.startsWith("$HOME/")) return resolve(home, word.slice(6));
    if (word.startsWith("${HOME}/")) return resolve(home, word.slice(8));
    return isAbsolute(word) ? resolve(word) : undefined;
}
