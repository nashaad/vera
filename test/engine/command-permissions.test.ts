import { beforeAll, expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import {
    bashTargetPaths,
    decideToolPermission,
    extractPermissionActions,
    permissionRulesDenial,
    type ApprovalMode,
    type PermissionRule,
} from "../../src/engine/permissions.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import type { HookToolCall } from "../../src/sdk/hooks.ts";
import { initBashParser } from "../../src/tools/bash-parser.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const workspace = "/Users/crow/harbor";
const homeDirectory = "/Users/crow";

function commandTool(execute: RegisteredTool["execute"] = async () => ({
    kind: "output", output: "launched", isError: false,
})): RegisteredTool {
    return {
        definition: {
            name: "crow_command",
            description: "Run a crow command.",
            inputSchema: {
                type: "object",
                properties: { script: { type: "string" } },
                required: ["script"],
            },
        },
        commandInput: "script",
        execute,
    };
}

function call(name: string, input: HookToolCall["input"]): HookToolCall {
    return { id: "call_1", name, input };
}

beforeAll(async () => {
    await initBashParser();
});

test("@core declared command inputs receive bash classification and target resolution", () => {
    const tools = [commandTool()];
    const options = { homeDirectory, extensionTools: tools };
    const commands = [
        "cat manifest.txt",
        "git push origin main",
        "printf crow > ../loot.txt",
        "rm -rf /",
        "bash -c 'rm -rf ~'",
    ];
    for (const command of commands) {
        const declared = call("crow_command", { script: command });
        const bash = call("bash", { command });
        for (const mode of ["readonly", "ask", "auto", "full_access"] as const) {
            expect(decideToolPermission(mode, declared, workspace, [], options))
                .toEqual(decideToolPermission(mode, bash, workspace, [], options));
        }
        expect(bashTargetPaths(declared, workspace, options))
            .toEqual(bashTargetPaths(bash, workspace, options));
        expect(extractPermissionActions({ toolCall: declared, workspace, homeDirectory }, tools))
            .toEqual(extractPermissionActions({ toolCall: bash, workspace, homeDirectory }, tools));
    }
});

test("@core declared commands obey bash deny rules, including the late deny pass", () => {
    const rules: readonly PermissionRule[] = [{
        name: "no-push", when: { operation: "git.push" }, then: "deny",
    }];
    const options = { homeDirectory, extensionTools: [commandTool()], permissionRules: rules };
    const toolCall = call("crow_command", { script: "git push origin main" });
    expect(decideToolPermission("auto", toolCall, workspace, [], options).behavior).toBe("deny");
    expect(permissionRulesDenial({ toolCall, workspace, homeDirectory }, rules, options)?.behavior)
        .toBe("deny");
    expect(decideToolPermission("full_access", call("crow_command", { script: "rm -rf /" }), workspace, [], options))
        .toMatchObject({ behavior: "deny", source: "accident_guard" });
});

test("@core the auto reviewer receives the exact declared command before execution", async () => {
    let executions = 0;
    let reviewed: HookToolCall | undefined;
    const tool = commandTool(async () => {
        executions += 1;
        return { kind: "output", output: "launched", isError: false };
    });
    const { channel, state } = turnState("auto", tool, async (request) => {
        reviewed = request.toolCall;
        return {
            decision: "deny",
            reason: "The crow cannot push.",
            riskLevel: "high",
            userAuthorization: "low",
        };
    });
    channel.client.send({ type: "prompt", content: "Check the crow's cargo." });
    await runTurn(new FauxAdapter([
        response("tool_use", [{ type: "tool_call", id: "call_1", name: "crow_command", input: {
            script: "git push origin main", description: "harmless crow",
        } }]),
        response("stop", [{ type: "text", text: "The cargo stayed aboard." }]),
    ]), "test", state);
    expect(reviewed).toEqual({ id: "call_1", name: "bash", input: { command: "git push origin main" } });
    expect(executions).toBe(0);
    await state.toolRuntime.close();
});

function turnState(
    approvalMode: ApprovalMode,
    tool: RegisteredTool,
    reviewToolCall?: RunTurnState["reviewToolCall"],
): {
    readonly channel: ReturnType<typeof createInProcessChannel>;
    readonly state: RunTurnState;
} {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    return {
        channel,
        state: {
            messages: [],
            store: new InMemorySessionStore(),
            toolRuntime: new ToolRuntime(process.cwd()),
            inbound: new InboundCommandRouter(channel.engine, events),
            events,
            hooks: new ToolHooks(),
            approvalMode,
            extensionTools: [tool],
            ...(reviewToolCall === undefined ? {} : { reviewToolCall }),
        },
    };
}

function response(
    stopReason: AssistantMessage["stopReason"],
    content: AssistantMessage["content"],
): AssistantMessage {
    return {
        role: "assistant",
        content,
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason,
    };
}
