import { describe, expect, test } from "bun:test";

import { resolveEffortArgument, resolveModeArgument, resolveModelArgument } from "../../clients/ui/src/composer/slash/args.ts";
import {
    invokeSkillLine,
    listExtensionCommandsLine,
    listSkillsLine,
    parseSlashReply,
    renameLine,
    runExtensionCommandLine,
} from "../../clients/ui/src/composer/slash/wire.ts";
import type { ModelEntry, ModelSettings } from "../../clients/ui/src/models/settings.ts";

function sent(text: string): Record<string, unknown> {
    expect(text.endsWith("\n")).toBe(true);
    return JSON.parse(text) as Record<string, unknown>;
}

function reply(value: unknown): ReturnType<typeof parseSlashReply> {
    return parseSlashReply(JSON.stringify(value));
}

describe("slash lines", () => {
    test("@core skills use camelCase fields and extension commands use snake_case", () => {
        expect(sent(listSkillsLine("r1"))).toEqual({ type: "list_skills", requestId: "r1" });
        expect(sent(invokeSkillLine("r2", "scout-the-field", "the north corn"))).toEqual({
            type: "invoke_skill",
            requestId: "r2",
            name: "scout-the-field",
            argumentsText: "the north corn",
        });
        expect(sent(listExtensionCommandsLine("r3"))).toEqual({ type: "list_extension_commands", request_id: "r3" });
        expect(sent(runExtensionCommandLine("r4", "budget", "5"))).toEqual({
            type: "run_extension_command",
            request_id: "r4",
            command: "budget",
            arguments_text: "5",
        });
    });

    test("a rename line carries the name, or null to clear it", () => {
        expect(sent(renameLine("r5", "Crow's nest"))).toEqual({ type: "update_session_name", requestId: "r5", name: "Crow's nest" });
        expect(sent(renameLine("r6", null))).toEqual({ type: "update_session_name", requestId: "r6", name: null });
    });
});

describe("parseSlashReply", () => {
    test("@core a skill catalog keeps named skills and drops the rest", () => {
        expect(reply({
            type: "skill_catalog",
            requestId: "r1",
            skills: [{ name: "scout", description: "Look around" }, { name: "" }, 4, { name: "plain" }],
        })).toEqual({
            type: "skills",
            requestId: "r1",
            skills: [{ name: "scout", description: "Look around" }, { name: "plain", description: "" }],
        });
    });

    test("an extension command list reads usage and source, and tolerates missing ones", () => {
        expect(reply({
            type: "extension_command_list",
            request_id: "r2",
            commands: [{ name: "budget", description: "Spend", usage: "/budget [n]", source: "vera.budget/budget" }, { name: "bare" }],
        })).toEqual({
            type: "extension_commands",
            requestId: "r2",
            commands: [
                { name: "budget", description: "Spend", usage: "/budget [n]", source: "vera.budget/budget" },
                { name: "bare", description: "", usage: "", source: "" },
            ],
        });
    });

    test("a catalog longer than the cap is cut", () => {
        const skills = Array.from({ length: 700 }, (_, index) => ({ name: `s${index}` }));
        const parsed = reply({ type: "skill_catalog", requestId: "r3", skills });
        expect(parsed?.type === "skills" && parsed.skills.length).toBe(500);
    });

    test("@core an extension result is worded as the terminal words it", () => {
        const body = (value: unknown): unknown => ({
            type: "extension_command_result",
            request_id: "r4",
            result: { source: "vera.budget/budget", body: value },
        });
        expect(reply(body({ kind: "text", text: "5 left" }))).toEqual({
            type: "extension_result", requestId: "r4", text: "vera.budget/budget: 5 left",
        });
        expect(reply(body({ kind: "handled" }))).toEqual({
            type: "extension_result", requestId: "r4", text: "vera.budget/budget",
        });
        expect(reply(body({ kind: "notice", level: "warning", text: "low" }))).toEqual({
            type: "extension_result", requestId: "r4", text: "vera.budget/budget [warning]: low",
        });
    });

    test("@core an extension failure uses the message, else a sentence for the reason", () => {
        const failure = (value: unknown): unknown => ({ type: "extension_command_failed", request_id: "r5", failure: value });
        expect(reply(failure({ source: "a/b", reason: "timeout" }))).toEqual({
            type: "extension_failed", requestId: "r5", text: "a/b: the command took too long",
        });
        expect(reply(failure({ source: "a/b", reason: "handler_failed", message: "no ledger" }))).toEqual({
            type: "extension_failed", requestId: "r5", text: "a/b: no ledger",
        });
        expect(reply(failure({ source: "a/b", reason: "mystery" }))).toEqual({
            type: "extension_failed", requestId: "r5", text: "a/b: the command failed",
        });
    });

    test("@core a skill is accepted, queued or rejected", () => {
        expect(reply({ type: "skill_invocation_accepted", requestId: "r6", name: "scout", queued: true, prompt: "/scout" })).toEqual({
            type: "skill_accepted", requestId: "r6", name: "scout", queued: true,
        });
        expect(reply({ type: "skill_invocation_accepted", requestId: "r6", name: "scout" })).toEqual({
            type: "skill_accepted", requestId: "r6", name: "scout", queued: false,
        });
        expect(reply({ type: "skill_invocation_rejected", requestId: "r7", name: "scout", reason: "Skill scout is manual only" })).toEqual({
            type: "skill_rejected", requestId: "r7", name: "scout", reason: "Skill scout is manual only",
        });
    });

    test("@core a rename is confirmed with the stored name or rejected with a reason", () => {
        expect(reply({ type: "session_name", requestId: "r8", name: "Crow's nest" })).toEqual({
            type: "renamed", requestId: "r8", name: "Crow's nest",
        });
        expect(reply({ type: "session_name", requestId: "r8", name: null })).toEqual({ type: "renamed", requestId: "r8", name: null });
        expect(reply({ type: "session_name_rejected", requestId: "r9", reason: "invalid" })).toEqual({
            type: "rename_rejected", requestId: "r9", reason: "invalid",
        });
    });

    test("@core lines that are not replies to a request parse to nothing", () => {
        expect(parseSlashReply("not json")).toBeUndefined();
        expect(parseSlashReply("[]")).toBeUndefined();
        expect(reply({ type: "assistant_delta", text: "hi" })).toBeUndefined();
        expect(reply({ type: "skill_catalog", skills: [] })).toBeUndefined();
        expect(reply({ type: "skill_catalog", requestId: "r", skills: "none" })).toBeUndefined();
        expect(reply({ type: "session_name", requestId: "r", name: 3 })).toBeUndefined();
    });
});

const LEVELS = [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
];

function model(provider: string, id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
    return {
        provider,
        model: id,
        label: id,
        onPareto: false,
        verified: true,
        hidden: false,
        recommended: false,
        levels: LEVELS,
        available: true,
        ...overrides,
    };
}

const SETTINGS: ModelSettings = {
    model: "nest-small",
    efforts: [],
    shortlist: [model("acme", "nest-small", { label: "Nest Small" }), model("acme", "nest-large", { label: "Nest Large" })],
    catalog: [model("roost", "caw-1"), model("roost", "gone", { available: false })],
};

describe("slash arguments", () => {
    test("@core /model picks an exact id, provider/id or label", () => {
        expect(resolveModelArgument(SETTINGS, "nest-large")).toEqual({ kind: "pick", choice: { provider: "acme", model: "nest-large" } });
        expect(resolveModelArgument(SETTINGS, "roost/caw-1")).toEqual({ kind: "pick", choice: { provider: "roost", model: "caw-1" } });
        expect(resolveModelArgument(SETTINGS, "nest small")).toEqual({ kind: "pick", choice: { provider: "acme", model: "nest-small" } });
    });

    test("@core /model picks the only model the words match, else searches", () => {
        expect(resolveModelArgument(SETTINGS, "caw")).toEqual({ kind: "pick", choice: { provider: "roost", model: "caw-1" } });
        expect(resolveModelArgument(SETTINGS, "nest")).toEqual({ kind: "search", query: "nest" });
        expect(resolveModelArgument(SETTINGS, "nothing here")).toEqual({ kind: "search", query: "nothing here" });
        expect(resolveModelArgument(SETTINGS, "gone")).toEqual({ kind: "search", query: "gone" });
    });

    test("@core /effort takes a level id or label, or default, and names the choices otherwise", () => {
        expect(resolveEffortArgument(LEVELS, "high")).toEqual({ kind: "set", effort: "high" });
        expect(resolveEffortArgument(LEVELS, " Low ")).toEqual({ kind: "set", effort: "low" });
        expect(resolveEffortArgument(LEVELS, "Default")).toEqual({ kind: "set", effort: null });
        expect(resolveEffortArgument(LEVELS, "max")).toEqual({ kind: "unknown", levels: ["low", "high"] });
    });

    test("@core /permissions takes a mode id, spaced id or label, and lists the modes otherwise", () => {
        expect(resolveModeArgument([], "readonly")).toEqual({ kind: "set", mode: "readonly" });
        expect(resolveModeArgument([], "full access")).toEqual({ kind: "set", mode: "full_access" });
        expect(resolveModeArgument([], "Approve for me")).toEqual({ kind: "set", mode: "auto" });
        expect(resolveModeArgument(["scout_only"], "scout only")).toEqual({ kind: "set", mode: "scout_only" });
        expect(resolveModeArgument([], "reckless")).toEqual({
            kind: "unknown",
            modes: ["ask", "auto", "readonly", "full_access"],
        });
    });
});
