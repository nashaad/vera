import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { buildWorkIndex } from "../../src/host/work-index.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";
import type { SessionSearchResults } from "../../src/store/session-search.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

installTestProcessGuard();

/**
 * A TUI holding a fixed work index and a fixed search answer, so a pane
 * assertion reads the surfaces rather than the timing of a live host.
 *
 * Ages are minutes back from this process's own start, not fixed instants:
 * the client renders relative time against the real clock, so a pane can only
 * assert "2m ago" if the fixture is that far back from the same clock.
 */

const START = Date.now();
const now = () => START;
const minutesAgo = (minutes: number): string =>
    new Date(START - minutes * 60_000).toISOString();

const INDEX: WorkIndexSnapshot = buildWorkIndex([
    {
        id: "auth-race",
        session_path: "/sessions/auth-race.jsonl",
        title: "auth-race",
        workspace: "/work/one",
        kind: "interactive",
        status: "waiting",
        live: true,
        updated_at: minutesAgo(2),
        pending_request: {
            type: "tool_approval",
            toolCall: {
                id: "call",
                name: "bash",
                input: { command: "bun migrate --production" },
            },
            reason: "",
            warning: "",
        },
    },
    {
        id: "browser-tests",
        session_path: "/sessions/browser-tests.jsonl",
        title: "browser-tests",
        workspace: "/work/one",
        kind: "interactive",
        status: "waiting",
        live: true,
        updated_at: minutesAgo(6),
        pending_request: {
            type: "user_question",
            question: "Which environment fails?",
            choices: [],
        },
    },
    {
        id: "relay-gui",
        session_path: "/sessions/relay-gui.jsonl",
        title: "relay-gui",
        workspace: "/work/one",
        kind: "interactive",
        status: "working",
        live: true,
        active_tool: "edit",
        updated_at: minutesAgo(9),
    },
    {
        id: "sub-one",
        session_path: "/sessions/sub-one.jsonl",
        title: "sub-one",
        workspace: "/work/one",
        kind: "background",
        status: "working",
        live: true,
        parent_id: "relay-gui",
        updated_at: minutesAgo(9),
    },
    {
        id: "sub-two",
        session_path: "/sessions/sub-two.jsonl",
        title: "sub-two",
        workspace: "/work/one",
        kind: "background",
        status: "working",
        live: true,
        parent_id: "relay-gui",
        updated_at: minutesAgo(9),
    },
    {
        id: "auth-refactor",
        session_path: "/sessions/auth-refactor.jsonl",
        title: "auth-refactor",
        workspace: "/work/one",
        kind: "interactive" as const,
        status: "completed" as const,
        live: false,
        changed_files: 5,
        updated_at: minutesAgo(11),
    },
    {
        id: "provider-fallback",
        session_path: "/sessions/provider-fallback.jsonl",
        title: "provider-fallback",
        workspace: "/work/one",
        kind: "background",
        status: "completed",
        live: false,
        unread_result: true,
        updated_at: minutesAgo(14),
    },
    // Enough sessions to overflow any card, so scrolling is exercised.
    ...(process.env.VERA_TEST_MANY === "1"
        ? Array.from({ length: 40 }, (_, index) => ({
            id: `bulk-${index}`,
            session_path: `/sessions/bulk-${index}.jsonl`,
            title: `bulk-${index}`,
            workspace: "/work/one",
            kind: "interactive" as const,
            status: "working" as const,
            live: true,
            updated_at: minutesAgo(20 + index),
        }))
        : []),
], [], { now });

const SEARCH: SessionSearchResults = {
    truncated: false,
    results: [
        {
            // Under the history flag this names the session that is open, so
            // the match can be landed on without a second host to resume from.
            session_id: process.env.VERA_TEST_HISTORY === "1"
                ? "work-tab-child"
                : "relay-gui",
            session_path: "/sessions/relay-gui.jsonl",
            title: "relay-gui",
            workspace: "/work/one",
            updated_at: minutesAgo(120),
            hits: [{
                kind: "user_message",
                snippet: "if the provider fallback kicks in, does the sidebar",
                entry_id: "entry-3",
            }],
        },
        {
            session_id: "provider-fallback",
            session_path: "/sessions/provider-fallback.jsonl",
            title: "provider-fallback",
            workspace: "/work/one",
            updated_at: minutesAgo(1_500),
            hits: [
                {
                    kind: "agent_message",
                    snippet: "the fallback ladder degrades in place",
                    entry_id: "entry-9",
                },
                {
                    kind: "tool_command",
                    snippet: "bun test tests/unit/fallback",
                    entry_id: "entry-10",
                },
            ],
        },
    ],
};

/**
 * A long history whose matching row is far from the end, so a transcript that
 * opened at its tail and one that landed on the match look different.
 */
const HISTORY = Array.from({ length: 60 }, (_, index) => ({
    id: `entry-${index}`,
    kind: "user" as const,
    text: index === 3
        ? "MATCHED the provider fallback question"
        : `filler line ${index}`,
}));

/**
 * The roster the workspace side bar lists, separate from the work index.
 *
 * The index only carries sessions with work in them; the side bar lists every
 * session there is, and takes its status from the index on top of this.
 */
const ROSTER = [
    {
        id: "work-tab-child",
        session_path: "/sessions/work-tab-child.jsonl",
        title: "this one",
        workspace: "/work/one",
        kind: "interactive" as const,
        status: "idle" as const,
        live: true,
        updated_at: minutesAgo(1),
    },
    {
        id: "auth-race",
        session_path: "/sessions/auth-race.jsonl",
        title: "auth-race",
        workspace: "/work/one",
        kind: "interactive" as const,
        status: "waiting" as const,
        live: true,
        updated_at: minutesAgo(2),
    },
    {
        id: "relay-gui",
        session_path: "/sessions/relay-gui.jsonl",
        title: "relay-gui",
        workspace: "/work/one",
        kind: "interactive" as const,
        status: "working" as const,
        live: true,
        updated_at: minutesAgo(9),
    },
    {
        id: "auth-refactor",
        session_path: "/sessions/auth-refactor.jsonl",
        title: "auth-refactor",
        workspace: "/work/two",
        kind: "interactive" as const,
        status: "completed" as const,
        live: false,
        updated_at: minutesAgo(11),
    },
    {
        id: "provider-fallback",
        session_path: "/sessions/provider-fallback.jsonl",
        title: "provider-fallback",
        workspace: "/work/one",
        kind: "background" as const,
        status: "completed" as const,
        live: false,
        updated_at: minutesAgo(14),
    },
];

if (process.env.VERA_TEST_MANY === "1") {
    for (let index = 0; index < 40; index += 1) {
        ROSTER.push({
            id: `bulk-${index}`,
            session_path: `/sessions/bulk-${index}.jsonl`,
            title: `bulk-${index}`,
            workspace: "/work/one",
            kind: "interactive",
            status: "working",
            live: true,
            updated_at: minutesAgo(20 + index),
        });
    }
}

const channel = createInProcessChannel();
void runHeadlessLoop(
    channel.engine,
    new FauxAdapter([response("ready")]),
    "test",
    "high",
    {
        approvalMode: "auto",
    },
    {
        readModelSettings: () => ({
            model: "test",
            reasoningEffort: "high",
            contextWindow: 100,
        }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: {
            updateModelSettings: async () => undefined,
        },
    },
);

const workIndexListeners = new Set<(index: WorkIndexSnapshot) => void>();

/**
 * A second index with one more session needing an answer, pushed once the TUI
 * is up. This is the only thing that exercises the notification path: a notice
 * fires on work that arrives, never on work that was already there.
 */
const LATER: WorkIndexSnapshot = buildWorkIndex([
    {
        id: "late-arrival",
        session_path: "/sessions/late-arrival.jsonl",
        title: "late-arrival",
        workspace: "/work/one",
        kind: "interactive",
        status: "waiting",
        live: true,
        updated_at: minutesAgo(0),
        pending_request: {
            type: "user_question",
            question: "Ship it?",
            choices: [],
        },
    },
], [], { now });

if (process.env.VERA_TEST_PUSH_WORK_AFTER_MS !== undefined) {
    setTimeout(() => {
        // The session is registered before the index that mentions it is
        // pushed, as a host registers one before it announces its work.
        ROSTER.push({
            id: "late-arrival",
            session_path: "/sessions/late-arrival.jsonl",
            title: "late-arrival",
            workspace: "/work/one",
            kind: "interactive" as const,
            status: "waiting" as const,
            live: true,
            updated_at: minutesAgo(0),
        });
        for (const listener of workIndexListeners) listener(LATER);
    }, Number(process.env.VERA_TEST_PUSH_WORK_AFTER_MS));
}
const client: TuiAgentClient = {
    agentId: "work-tab-child",
    workspace: "/work/one",
    workIndex: INDEX,
    onWorkIndex(listener): () => void {
        workIndexListeners.add(listener);
        return (): void => {
            workIndexListeners.delete(listener);
        };
    },
    async send(command): Promise<void> {
        channel.client.send(command);
    },
    receive(signal) {
        return channel.client.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

if (process.env.VERA_TEST_HISTORY === "1") {
    // Pushed as the host would, so the client builds its rows the ordinary way.
    setTimeout(() => {
        channel.engine.send({ type: "history", entries: HISTORY, seq: 0 });
    }, 500);
}

// Names what enter asked for, so a pane can assert the routing without a real
// host to resume into.
const opened: string[] = [];

await startTui({
    client,
    copyText: async () => undefined,
    ...(process.env.VERA_TEST_HISTORY === "1" ? {} : {
        resumeSession: async (sessionPath) => {
            opened.push(sessionPath);
            throw new Error(`OPENED ${sessionPath}`);
        },
    }),
    listAgents: async () => ROSTER,
    searchSessions: async (query) =>
        query.kind === "files"
            ? { results: [], truncated: false }
            : SEARCH,
});

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
