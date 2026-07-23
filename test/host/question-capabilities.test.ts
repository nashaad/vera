import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isUserQuestionUiRequestUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("interactive resident agents expose ask_user to the model", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-question-capability-"));
    const requests: ModelRequest[] = [];
    const faux = new FauxAdapter([questionResponse(), textResponse("done")]);
    const registry = registryWithAdapter(root, recordingAdapter(faux, requests));

    try {
        const agent = await registry.create({ id: "interactive", workspace: root });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "prompt", content: "ask first" });
        expect((await attachment.receive()).type).toBe("user_prompt");
        const update = await receiveQuestion(attachment);
        attachment.send({
            type: "ui_response",
            requestId: update.requestId,
            response: { type: "user_question", outcome: "cancelled" },
        });
        await drainTurn(attachment);

        expect(toolNames(requests[0])).toContain("ask_user");
        expect(requests).toHaveLength(2);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("background resident agents do not expose ask_user", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-background-capability-"));
    const parentRequests: ModelRequest[] = [];
    const childRequests: ModelRequest[] = [];
    let adapterNumber = 0;
    const registry = new AgentRegistry({
        createAdapter() {
            adapterNumber += 1;
            return adapterNumber === 1
                ? recordingAdapter(new FauxAdapter([
                    backgroundResponse(),
                    textResponse("started"),
                ]), parentRequests)
                : recordingAdapter(
                    new FauxAdapter([textResponse("child done")]),
                    childRequests,
                );
        },
        model: "faux/test",
        approvalMode: "full_access",
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        eventLogPathForId: (id) => join(root, `${id}-events.jsonl`),
    });

    try {
        const parent = await registry.create({ id: "parent", workspace: root });
        const attachment = parent.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "prompt", content: "run it in background" });
        await drainTurn(attachment);
        await waitForBackgroundCompletion(registry);

        expect(parentRequests).not.toHaveLength(0);
        for (const request of parentRequests) {
            expect(toolNames(request)).toContain("ask_user");
        }
        expect(childRequests).toHaveLength(1);
        expect(toolNames(childRequests[0])).not.toContain("ask_user");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

function registryWithAdapter(root: string, adapter: ModelAdapter): AgentRegistry {
    return new AgentRegistry({
        createAdapter: () => adapter,
        model: "faux/test",
        approvalMode: "full_access",
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        eventLogPathForId: (id) => join(root, `${id}-events.jsonl`),
    });
}

function recordingAdapter(
    adapter: ModelAdapter,
    requests: ModelRequest[],
): ModelAdapter {
    return {
        stream(request) {
            requests.push(request);
            return adapter.stream(request);
        },
    };
}

async function drainTurn(attachment: AgentAttachment): Promise<void> {
    while ((await attachment.receive()).type !== "turn_finished") {
        // Drain the resident updates through the terminal turn event.
    }
}

async function receiveQuestion(
    attachment: AgentAttachment,
): Promise<Extract<Awaited<ReturnType<AgentAttachment["receive"]>>, {
    readonly type: "ui_request";
}>> {
    while (true) {
        const update = await attachment.receive();
        if (
            update.type === "ui_request"
            && isUserQuestionUiRequestUpdate(update)
        ) {
            return update;
        }
    }
}

async function waitForBackgroundCompletion(registry: AgentRegistry): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (registry.list().some(
            (agent) => agent.kind === "background" && agent.status === "completed",
        )) {
            return;
        }
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for background completion");
}

function toolNames(request: ModelRequest | undefined): string[] {
    return request?.tools?.map((tool) => tool.name) ?? [];
}

function questionResponse(): AssistantMessage {
    return toolResponse("question-1", "ask_user", {
        question: "How should Vera continue?",
        choices: [
            { id: "automatic", label: "Continue automatically" },
            { id: "manual", label: "Wait for me" },
        ],
    });
}

function backgroundResponse(): AssistantMessage {
    return toolResponse("background-1", "background_agent", {
        description: "run child",
    });
}

function toolResponse(
    id: string,
    name: string,
    input: Record<string, unknown>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
