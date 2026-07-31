import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { PostToolUseHook } from "../sdk/hooks.ts";

/**
 * A reminder rule: when a file-writing tool call's path matches `match`, the
 * rule's `remind` text is appended to that tool result. Rules are user data
 * read from a TOML file; the same file also drives the equivalent hooks in
 * other harnesses.
 */
export interface ReminderRule {
    readonly id: string;
    /** Glob matched against the absolute path the tool wrote. */
    readonly match: string;
    readonly remind: string;
}

export interface ReminderRulesFile {
    readonly cooldownMinutes: number;
    readonly rules: readonly ReminderRule[];
}

const DEFAULT_COOLDOWN_MINUTES = 10;
const FILE_WRITING_TOOLS = new Set(["write", "edit"]);

export function defaultReminderRulesPath(): string {
    return join(homedir(), ".vera", "extensions", "reminders", "rules.toml");
}

/**
 * Loads reminder rules from a TOML file. A missing, unreadable, or malformed
 * file reads as no rules rather than failing anything: reminders are an
 * affordance, not a dependency. Entries missing a field are skipped.
 */
export async function loadReminderRules(
    path: string = defaultReminderRulesPath(),
): Promise<ReminderRulesFile> {
    const none: ReminderRulesFile = {
        cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
        rules: [],
    };
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        return none;
    }
    let parsed: unknown;
    try {
        parsed = Bun.TOML.parse(raw);
    } catch {
        return none;
    }
    if (parsed === null || typeof parsed !== "object") {
        return none;
    }
    const { cooldown_minutes, rules } = parsed as Record<string, unknown>;
    if (!Array.isArray(rules)) {
        return none;
    }
    return {
        cooldownMinutes: typeof cooldown_minutes === "number"
                && cooldown_minutes > 0
            ? cooldown_minutes
            : DEFAULT_COOLDOWN_MINUTES,
        rules: rules.flatMap((entry) => {
            if (entry === null || typeof entry !== "object") {
                return [];
            }
            const { id, match, remind } = entry as Record<string, unknown>;
            return typeof id === "string"
                    && typeof match === "string"
                    && typeof remind === "string"
                ? [{ id, match, remind }]
                : [];
        }),
    };
}

/**
 * A post_tool_use hook that appends matching reminder texts to successful
 * write/edit results. The rules file is re-read on each firing so edits apply
 * without a restart; each rule is silenced for the file's cooldown after it
 * fires. Create one instance per session so cooldowns stay session-local.
 */
export function createReminderHook(rulesPath?: string): PostToolUseHook {
    const lastFired = new Map<string, number>();
    return async (payload) => {
        if (payload.result.isError) {
            return { power: "observe" };
        }
        if (!FILE_WRITING_TOOLS.has(payload.toolCall.name)) {
            return { power: "observe" };
        }
        const path = payload.toolCall.input.path;
        if (typeof path !== "string") {
            return { power: "observe" };
        }
        const file = await loadReminderRules(rulesPath);
        const absolute = isAbsolute(path)
            ? path
            : join(payload.workspace, path);
        const now = Date.now();
        const fired = file.rules.filter((rule) => {
            const last = lastFired.get(rule.id);
            if (last !== undefined && now - last < file.cooldownMinutes * 60_000) {
                return false;
            }
            return new Bun.Glob(rule.match).match(absolute);
        });
        if (fired.length === 0) {
            return { power: "observe" };
        }
        for (const rule of fired) {
            lastFired.set(rule.id, now);
        }
        return {
            power: "mutate",
            patch: {
                content: [
                    ...payload.result.content,
                    ...fired.map((rule): { type: "text"; text: string } => ({
                        type: "text",
                        text: `Reminder: ${rule.remind}`,
                    })),
                ],
            },
        };
    };
}
