// Lines the slash menu writes to a session's watch connection, and the replies it reads back.
import type { ExtensionCommandInfo, SkillCommandInfo } from "./model.ts";

export type SlashReply =
    | { readonly type: "skills"; readonly requestId: string; readonly skills: readonly SkillCommandInfo[] }
    | { readonly type: "extension_commands"; readonly requestId: string; readonly commands: readonly ExtensionCommandInfo[] }
    | { readonly type: "extension_result"; readonly requestId: string; readonly text: string }
    | { readonly type: "extension_failed"; readonly requestId: string; readonly text: string }
    | { readonly type: "skill_accepted"; readonly requestId: string; readonly name: string; readonly queued: boolean }
    | { readonly type: "skill_rejected"; readonly requestId: string; readonly name: string; readonly reason: string }
    | { readonly type: "renamed"; readonly requestId: string; readonly name: string | null }
    | { readonly type: "rename_rejected"; readonly requestId: string; readonly reason: string };

type Fields = Record<string, unknown>;

// A catalog longer than this is cut.
const CATALOG_LIMIT = 500;

export function listSkillsLine(requestId: string): string {
    return line({ type: "list_skills", requestId });
}

export function invokeSkillLine(requestId: string, name: string, argumentsText: string): string {
    return line({ type: "invoke_skill", requestId, name, argumentsText });
}

export function listExtensionCommandsLine(requestId: string): string {
    return line({ type: "list_extension_commands", request_id: requestId });
}

export function runExtensionCommandLine(requestId: string, command: string, argumentsText: string): string {
    return line({ type: "run_extension_command", request_id: requestId, command, arguments_text: argumentsText });
}

// A null name clears the session's name.
export function renameLine(requestId: string, name: string | null): string {
    return line({ type: "update_session_name", requestId, name });
}

export function parseSlashReply(text: string): SlashReply | undefined {
    const value = parseJson(text);
    if (!isFields(value)) return undefined;
    const requestId = typeof value.requestId === "string" ? value.requestId : value.request_id;
    if (typeof requestId !== "string") return undefined;
    switch (value.type) {
        case "skill_catalog":
            return Array.isArray(value.skills)
                ? { type: "skills", requestId, skills: value.skills.slice(0, CATALOG_LIMIT).flatMap(parseSkill) }
                : undefined;
        case "extension_command_list":
            return Array.isArray(value.commands)
                ? { type: "extension_commands", requestId, commands: value.commands.slice(0, CATALOG_LIMIT).flatMap(parseExtension) }
                : undefined;
        case "extension_command_result":
            return isFields(value.result) ? { type: "extension_result", requestId, text: resultText(value.result) } : undefined;
        case "extension_command_failed":
            return isFields(value.failure) ? { type: "extension_failed", requestId, text: failureText(value.failure) } : undefined;
        case "skill_invocation_accepted":
            return typeof value.name === "string"
                ? { type: "skill_accepted", requestId, name: value.name, queued: value.queued === true }
                : undefined;
        case "skill_invocation_rejected":
            return typeof value.name === "string" && typeof value.reason === "string"
                ? { type: "skill_rejected", requestId, name: value.name, reason: value.reason }
                : undefined;
        case "session_name":
            return value.name === null || typeof value.name === "string"
                ? { type: "renamed", requestId, name: value.name }
                : undefined;
        case "session_name_rejected":
            return typeof value.reason === "string" ? { type: "rename_rejected", requestId, reason: value.reason } : undefined;
        default:
            return undefined;
    }
}

function parseSkill(value: unknown): SkillCommandInfo[] {
    if (!isFields(value) || typeof value.name !== "string" || value.name.length === 0) return [];
    return [{ name: value.name, description: typeof value.description === "string" ? value.description : "" }];
}

function parseExtension(value: unknown): ExtensionCommandInfo[] {
    if (!isFields(value) || typeof value.name !== "string" || value.name.length === 0) return [];
    return [{
        name: value.name,
        description: typeof value.description === "string" ? value.description : "",
        usage: typeof value.usage === "string" ? value.usage : "",
        source: typeof value.source === "string" ? value.source : "",
    }];
}

// The same wording the terminal prints for an extension command's result.
function resultText(result: Fields): string {
    const source = typeof result.source === "string" ? result.source : "extension";
    const body = isFields(result.body) ? result.body : {};
    const text = typeof body.text === "string" ? body.text : "";
    if (body.kind === "text") return `${source}: ${text}`;
    if (body.kind === "handled") return source;
    const level = typeof body.level === "string" ? body.level : "info";
    return `${source} [${level}]: ${text}`;
}

const FAILURE_REASONS: Readonly<Record<string, string>> = {
    unavailable: "the command is not available",
    handler_failed: "the command failed",
    timeout: "the command took too long",
    cancelled: "the command was cancelled",
    invalid_result: "the command returned something Vera could not read",
};

function failureText(failure: Fields): string {
    const source = typeof failure.source === "string" ? failure.source : "extension";
    const message = typeof failure.message === "string" && failure.message.length > 0 ? failure.message : undefined;
    const reason = typeof failure.reason === "string" ? FAILURE_REASONS[failure.reason] : undefined;
    return `${source}: ${message ?? reason ?? "the command failed"}`;
}

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
