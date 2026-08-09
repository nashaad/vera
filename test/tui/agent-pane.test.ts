import { expect, test } from "bun:test";

import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    TuiAgentPane,
    type TuiAgentPaneClient,
} from "../../clients/tui/agent-pane.ts";

interface FakePaneClient extends TuiAgentPaneClient {
    readonly updates: AsyncQueue<AgentUpdate>;
    readonly detached: string[];
}

function client(agentId: string): FakePaneClient {
    const updates = new AsyncQueue<AgentUpdate>();
    const detached: string[] = [];
    return {
        agentId,
        updates,
        detached,
        receive: (signal) => updates.receive(signal),
        async detach() {
            detached.push(agentId);
        },
        close() {},
    };
}

test("two pane pumps consume updates independently", async () => {
    const mainClient = client("main");
    const sideClient = client("side");
    const seen: string[] = [];
    const settled = Promise.withResolvers<void>();
    const onUpdate = (update: AgentUpdate, pane: TuiAgentPane<FakePaneClient>) => {
        seen.push(`${pane.agentId}:${update.type}`);
        if (seen.length === 4) settled.resolve();
    };
    const main = new TuiAgentPane({ client: mainClient, onUpdate });
    const side = new TuiAgentPane({ client: sideClient, onUpdate });
    main.start();
    side.start();

    mainClient.updates.push({
        type: "user_prompt",
        content: "main question",
        seq: 1,
    });
    sideClient.updates.push({
        type: "user_prompt",
        content: "side question",
        seq: 1,
    });
    sideClient.updates.push({
        type: "assistant_delta",
        text: "side answer",
        seq: 2,
    });
    mainClient.updates.push({
        type: "assistant_delta",
        text: "main answer",
        seq: 2,
    });
    await settled.promise;

    expect(seen).toHaveLength(4);
    expect(seen.filter((item) => item.startsWith("main:"))).toEqual([
        "main:user_prompt",
        "main:assistant_delta",
    ]);
    expect(seen.filter((item) => item.startsWith("side:"))).toEqual([
        "side:user_prompt",
        "side:assistant_delta",
    ]);
    expect(main.state.state.entries.at(-1)?.text).toBe("main answer");
    expect(side.state.state.entries.at(-1)?.text).toBe("side answer");

    await Promise.all([main.detach(), side.detach()]);
});

test("detaching one pane stops only its pump", async () => {
    const mainClient = client("main");
    const sideClient = client("side");
    const main = new TuiAgentPane({ client: mainClient });
    const side = new TuiAgentPane({ client: sideClient });
    main.start();
    side.start();

    await side.detach();
    mainClient.updates.push({
        type: "user_prompt",
        content: "main continues",
        seq: 1,
    });
    await Bun.sleep(0);

    expect(sideClient.detached).toEqual(["side"]);
    expect(mainClient.detached).toEqual([]);
    expect(main.state.state.entries.at(-1)?.text).toBe("main continues");

    await main.detach();
});

test("a pane reports its own connection failure", async () => {
    const broken: TuiAgentPaneClient = {
        agentId: "broken",
        receive: () => Promise.reject(new Error("socket closed")),
        async detach() {},
        close() {},
    };
    const reported = Promise.withResolvers<string>();
    const pane = new TuiAgentPane({
        client: broken,
        onFailure: (error, source) =>
            reported.resolve(`${source.agentId}:${error.message}`),
    });

    pane.start();

    expect(await reported.promise).toBe("broken:socket closed");
    await pane.detach();
});

test("a pane clears its own abort state when its turn finishes", () => {
    const pane = new TuiAgentPane({ client: client("side") });
    pane.state.abortRequested = true;
    pane.state.apply({ type: "turn_finished", seq: 1 });
    expect(pane.state.abortRequested).toBe(false);
});
