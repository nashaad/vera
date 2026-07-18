import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import { defaultEventLogPath } from "../engine/events.ts";
import type { ApprovalMode } from "../engine/permissions.ts";
import type { ModelFallbackPolicy } from "../engine/recovery.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import {
    defaultSessionPath,
    SessionStore,
} from "../store/session-store.ts";
import { ResidentAgent } from "./resident-agent.ts";

export type RegisteredAgentStatus =
    | "idle"
    | "working"
    | "waiting"
    | "closed"
    | "failed";

export interface RegisteredAgentSummary {
    readonly id: string;
    readonly workspace: string;
    readonly session_path: string;
    readonly status: RegisteredAgentStatus;
}

export interface AgentRegistryOptions {
    readonly createAdapter: () => ModelAdapter;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly approvalMode: ApprovalMode;
    readonly modelFallback?: ModelFallbackPolicy;
}

export interface CreateRegisteredAgentOptions {
    readonly id?: string;
    readonly workspace: string;
    readonly sessionPath?: string;
    readonly eventLogPath?: string;
}

export interface ResumeRegisteredAgentOptions {
    readonly sessionPath: string;
    readonly eventLogPath?: string;
}

interface RegisteredAgentEntry {
    readonly agent: ResidentAgent;
    readonly store: SessionStore;
    run: Promise<void>;
    failure?: unknown;
}

export class AgentRegistry {
    private readonly agents = new Map<string, RegisteredAgentEntry>();
    private readonly startingIds = new Set<string>();
    private isClosed = false;

    constructor(private readonly options: AgentRegistryOptions) {}

    async create(
        options: CreateRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        const id = options.id ?? randomUUID();
        this.reserveId(id);
        try {
            const workspace = await realpath(options.workspace);
            const store = await SessionStore.create(
                options.sessionPath ?? defaultSessionPath(id),
                { sessionId: id, cwd: workspace },
            );
            this.requireOpen();
            return this.start(store, options.eventLogPath);
        } finally {
            this.startingIds.delete(id);
        }
    }

    async resume(
        options: ResumeRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        const store = await SessionStore.open(options.sessionPath);
        this.reserveId(store.header.id);
        try {
            this.requireOpen();
            return this.start(store, options.eventLogPath);
        } finally {
            this.startingIds.delete(store.header.id);
        }
    }

    find(id: string): ResidentAgent | undefined {
        const agent = this.agents.get(id)?.agent;
        return agent?.closed === false ? agent : undefined;
    }

    list(): RegisteredAgentSummary[] {
        return [...this.agents.values()]
            .map((entry) => ({
                id: entry.agent.id,
                workspace: entry.agent.workspace,
                session_path: entry.store.path,
                status: entry.failure !== undefined
                    ? "failed" as const
                    : entry.agent.closed
                        ? "closed" as const
                        : entry.agent.status,
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    async close(): Promise<void> {
        this.isClosed = true;
        const entries = [...this.agents.values()];
        for (const entry of entries) {
            entry.agent.close();
        }
        await Promise.all(entries.map((entry) => entry.run));
    }

    private start(
        store: SessionStore,
        eventLogPath = defaultEventLogPath(store.header.id),
    ): ResidentAgent {
        const adapter = this.options.createAdapter();
        const agent = new ResidentAgent(store.header.id, store.header.cwd);
        const entry: RegisteredAgentEntry = {
            agent,
            store,
            run: Promise.resolve(),
        };
        this.agents.set(agent.id, entry);
        entry.run = runHeadlessLoop(
            agent.engine,
            adapter,
            this.options.model,
            this.options.reasoningEffort,
            {
                sessionStore: store,
                eventLogPath,
                approvalMode: this.options.approvalMode,
                modelFallback: this.options.modelFallback,
            },
        ).catch((error: unknown) => {
            if (!agent.closed) {
                entry.failure = error;
                agent.close();
            }
        });
        return agent;
    }

    private reserveId(id: string): void {
        this.requireOpen();
        if (this.agents.has(id) || this.startingIds.has(id)) {
            throw new Error(`Resident agent ${id} already exists`);
        }
        this.startingIds.add(id);
    }

    private requireOpen(): void {
        if (this.isClosed) {
            throw new Error("Agent registry is closed");
        }
    }
}
