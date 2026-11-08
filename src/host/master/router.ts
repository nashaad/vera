import type { CreateRegisteredAgentOptions, RegisteredAgentSummary, RenameSessionOutcome } from "../agent-registry.ts";
import type { AgentLocationFailedResponse, AgentLocationResponse, BlockSessionRequest, UnblockSessionRequest } from "../protocol.ts";
import type { BlockSessionOutcome, CloseAgentOutcome, UnblockSessionOutcome } from "../server.ts";
import { userFacingMessage } from "../../user-facing-error.ts";
import type { SessionEndReason } from "../../sdk/hooks.ts";
import type { SessionFactName } from "../../store/session-facts.ts";
import type { SessionSearchQuery, SessionSearchResults } from "../../store/session-search.ts";
import { mergeRoster, type SessionOwner } from "./roster.ts";

export interface RoutedSession {
    readonly id: string;
    readonly workspace: string;
    readonly sessionPath: string;
}

export interface SessionEndpoint {
    inspect(path: string): Promise<{ readonly id: string; readonly sessionPath: string }>;
    resident(id: string): Promise<RoutedSession | undefined>;
    residents(): Promise<readonly RoutedSession[]>;
    tree(id: string): Promise<readonly string[]>;
    find(id: string, reserved?: boolean): Promise<RoutedSession | undefined>;
    create(options: Pick<CreateRegisteredAgentOptions,
        "workspace" | "approvalMode" | "ephemeral" | "startupProfile">): Promise<RoutedSession>;
    resume(path: string, reserved?: boolean): Promise<RoutedSession>;
    release(id: string): Promise<readonly string[]>;
    list(): Promise<readonly RegisteredAgentSummary[]>;
    rename(id: string, name: string | null, reserved?: boolean): Promise<RenameSessionOutcome>;
    trash(id: string, reserved?: boolean): Promise<"trashed" | "busy" | "not_found" | "failed">;
    close(id: string, reason?: SessionEndReason): Promise<CloseAgentOutcome>;
    block(request: BlockSessionRequest): Promise<BlockSessionOutcome>;
    unblock(request: UnblockSessionRequest): Promise<UnblockSessionOutcome>;
    sync(id: string): Promise<{ readonly status: "synced" | "unchanged" | "busy" | "stale_cursor" | "not_found"; readonly turns: number }>;
    facts(sessions: readonly RegisteredAgentSummary[], include: readonly SessionFactName[]): Promise<readonly RegisteredAgentSummary[]>;
    search(query: SessionSearchQuery): Promise<SessionSearchResults>;
}

export interface HostRouterOptions {
    readonly master: SessionEndpoint;
    readonly worker: SessionEndpoint;
    readonly masterSocket: string;
    readonly workerSocket: string;
    readonly buildId: string;
}

export class HostRouter {
    private readonly owners = new Map<string, SessionOwner>();
    private readonly branches = new Map<string, number>();
    private pending: Promise<void> = Promise.resolve();

    constructor(private readonly options: HostRouterOptions) {}

    observe(owner: SessionOwner, sessions: readonly RoutedSession[]): void {
        for (const session of sessions) {
            const current = this.owners.get(session.id);
            if (current === undefined || current === owner) this.owners.set(session.id, owner);
        }
    }

    create(options: Pick<CreateRegisteredAgentOptions,
        "workspace" | "approvalMode" | "ephemeral" | "startupProfile">): Promise<RoutedSession> {
        return this.serial(async () => {
            const session = await this.options.worker.create(options);
            this.owners.set(session.id, "w0");
            return session;
        });
    }

    resume(path: string, reserved = false): Promise<RoutedSession> {
        return this.serial(async () => {
            const inspected = await this.options.worker.inspect(path);
            const [existing, master] = await Promise.all([
                this.options.worker.resident(inspected.id),
                this.options.master.resident(inspected.id),
            ]);
            if (existing !== undefined && master !== undefined) {
                throw new Error("Session is resident on both hosts");
            }
            if (existing !== undefined) {
                if ((await this.options.worker.inspect(existing.sessionPath)).sessionPath !== inspected.sessionPath) {
                    throw new Error("Session id is already in use");
                }
                this.owners.set(inspected.id, "w0");
                return existing;
            }
            if (master !== undefined) {
                if ((await this.options.master.tree(inspected.id)).some((id) => this.branches.has(id))) {
                    throw new Error("Session cannot be moved while branching");
                }
                if ((await this.options.master.inspect(master.sessionPath)).sessionPath !== inspected.sessionPath) {
                    throw new Error("Session id is already in use");
                }
                const released = await this.options.master.release(inspected.id);
                for (const id of released) this.owners.set(id, "w0");
            }
            this.owners.set(inspected.id, "w0");
            try {
                return await this.options.worker.resume(inspected.sessionPath, reserved);
            } catch (error) {
                this.owners.delete(inspected.id);
                throw error;
            }
        });
    }

    locate(id: string, reserved = false): Promise<AgentLocationResponse | AgentLocationFailedResponse> {
        return this.serial(async () => {
            try {
                const owner = await this.resolvedOwner(id) ?? "host";
                const session = await this.endpoint(owner).find(id, reserved);
                if (session === undefined) {
                    return { type: "agent_location_failed", reason: "not_found", message: "No session with this id is on this host." };
                }
                this.owners.set(id, owner);
                return {
                    type: "agent_location",
                    socket_path: owner === "w0" ? this.options.workerSocket : this.options.masterSocket,
                    worker_id: owner,
                    worker_generation: 1,
                    build_id: this.options.buildId,
                };
            } catch (error) {
                return {
                    type: "agent_location_failed", reason: "worker_unavailable",
                    message: userFacingMessage(error) ?? "The session could not be loaded.",
                };
            }
        });
    }

    find(owner: SessionOwner, id: string, reserved = false): Promise<boolean> {
        return this.serial(async () => {
            const assigned = await this.resolvedOwner(id);
            if (assigned !== undefined && assigned !== owner) return false;
            if (assigned === undefined && owner === "w0") return false;
            const session = await this.endpoint(owner).find(id, reserved);
            if (session === undefined) return false;
            this.owners.set(id, owner);
            return true;
        });
    }

    socketFor(from: SessionOwner, id: string): Promise<string | undefined> {
        return this.serial(async () => {
            const owner = await this.resolvedOwner(id) ?? "host";
            if (owner === from) return undefined;
            return owner === "w0" ? this.options.workerSocket : this.options.masterSocket;
        });
    }

    beginBranch(owner: SessionOwner, id: string): Promise<boolean> {
        return this.serial(async () => {
            if ((await this.resolvedOwner(id) ?? "host") !== owner) return false;
            this.branches.set(id, (this.branches.get(id) ?? 0) + 1);
            return true;
        });
    }

    endBranch(id: string): void {
        const count = this.branches.get(id);
        if (count === undefined || count <= 1) this.branches.delete(id);
        else this.branches.set(id, count - 1);
    }

    rename(id: string, name: string | null, reserved = false): Promise<RenameSessionOutcome> {
        return this.serial(async () => this.endpoint(await this.resolvedOwner(id) ?? "host").rename(id, name, reserved));
    }

    trash(id: string, reserved = false): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        return this.serial(async () => this.endpoint(await this.resolvedOwner(id) ?? "host").trash(id, reserved));
    }

    close(id: string, reason?: SessionEndReason): Promise<CloseAgentOutcome> {
        return this.serial(async () => this.endpoint(await this.resolvedOwner(id) ?? "host").close(id, reason));
    }

    block(request: BlockSessionRequest): Promise<BlockSessionOutcome> {
        return this.serial(async () => {
            const owner = await this.resolvedOwner(request.target_agent_id) ?? "host";
            for (const id of request.session_ids) {
                const assigned = await this.resolvedOwner(id);
                if (assigned !== undefined && assigned !== owner) return { status: "rejected", reason: "failed" };
            }
            return this.endpoint(owner).block(request);
        });
    }

    unblock(request: UnblockSessionRequest): Promise<UnblockSessionOutcome> {
        return this.serial(async () => {
            const owner = await this.resolvedOwner(request.target_agent_id) ?? "host";
            for (const id of request.session_ids) {
                const assigned = await this.resolvedOwner(id);
                if (assigned !== undefined && assigned !== owner) return { status: "rejected", reason: "failed" };
            }
            return this.endpoint(owner).unblock(request);
        });
    }

    sync(id: string): Promise<{ readonly status: "synced" | "unchanged" | "busy" | "stale_cursor" | "not_found"; readonly turns: number }> {
        return this.serial(async () => this.endpoint(await this.resolvedOwner(id) ?? "host").sync(id));
    }

    async facts(sessions: readonly RegisteredAgentSummary[], include: readonly SessionFactName[]): Promise<readonly RegisteredAgentSummary[]> {
        const [master, worker] = await this.serial(async () => {
            const master: RegisteredAgentSummary[] = [];
            const worker: RegisteredAgentSummary[] = [];
            for (const session of sessions) {
                (await this.resolvedOwner(session.id) === "w0" ? worker : master).push(session);
            }
            return [master, worker] as const;
        });
        const [masterRows, workerRows] = await Promise.all([
            this.options.master.facts(master, include),
            this.options.worker.facts(worker, include),
        ]);
        const rows = new Map([...masterRows, ...workerRows].map((row) => [row.id, row]));
        return sessions.map((session) => rows.get(session.id) ?? session);
    }

    async search(query: SessionSearchQuery): Promise<SessionSearchResults> {
        const owner = await this.serial(async () => query.session_id === undefined
                ? "w0"
                : await this.resolvedOwner(query.session_id) ?? "host");
        return await this.endpoint(owner).search(query);
    }

    list(): Promise<RegisteredAgentSummary[]> {
        return this.serial(async () => {
            const [master, worker, masterResidents, workerResidents] = await Promise.all([
                this.options.master.list(),
                this.options.worker.list(),
                this.options.master.residents(),
                this.options.worker.residents(),
            ]);
            const masterIds = new Set(masterResidents.map((session) => session.id));
            const workerIds = new Set(workerResidents.map((session) => session.id));
            for (const id of masterIds) {
                if (workerIds.has(id)) throw new Error("Session is resident on both hosts");
            }
            return mergeRoster(master, worker, (id) => workerIds.has(id)
                ? "w0"
                : masterIds.has(id) ? "host" : this.owners.get(id));
        });
    }

    private endpoint(owner: SessionOwner): SessionEndpoint {
        return owner === "host" ? this.options.master : this.options.worker;
    }

    private async owner(id: string): Promise<SessionOwner | undefined> {
        const [master, worker] = await Promise.all([
            this.options.master.resident(id), this.options.worker.resident(id),
        ]);
        if (master !== undefined && worker !== undefined) throw new Error("Session is resident on both hosts");
        return worker !== undefined ? "w0" : master !== undefined ? "host" : this.owners.get(id);
    }

    private async resolvedOwner(id: string): Promise<SessionOwner | undefined> {
        const assigned = await this.owner(id);
        if (assigned !== undefined) return assigned;
        const [master, worker] = await Promise.all([this.options.master.list(), this.options.worker.list()]);
        const rows = new Map([...master, ...worker].map((row) => [row.id, row]));
        const seen = new Set<string>([id]);
        let parent = rows.get(id)?.parent_id;
        while (parent !== undefined && !seen.has(parent)) {
            seen.add(parent);
            const owner = await this.owner(parent);
            if (owner !== undefined) {
                this.owners.set(id, owner);
                return owner;
            }
            parent = rows.get(parent)?.parent_id;
        }
        return undefined;
    }

    private serial<T>(run: () => T | Promise<T>): Promise<T> {
        const result = this.pending.then(run);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }
}
