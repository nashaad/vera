// The renderer keeps its own narrow projection of the wire shapes it reads, so
// the shared UI never imports host source at runtime or for typechecking.
export interface HostIdentityFacts {
    readonly pid: number;
    readonly protocol_version: number;
    readonly build_id?: string | null;
}

export interface AgentListFacts {
    readonly agents: readonly unknown[];
    readonly next_cursor?: string;
    readonly total?: number;
}

export interface ListAgentsOptions {
    readonly limit?: number;
    readonly order?: "id" | "recent";
}

const MAX_FRAME_BYTES = 1_048_576;
const RESPONSE_TIMEOUT_MS = 5_000;

interface Pending {
    readonly expected: string;
    readonly promise: Promise<unknown>;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

interface Deferred {
    readonly promise: Promise<unknown>;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
}

function deferred(): Deferred {
    let resolve: (value: unknown) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export class HostProtocolClient {
    private readonly pending = new Map<string, Pending>();
    private buffered = "";
    private failed: Error | undefined;

    constructor(private readonly sendFrame: (text: string) => void) {}

    hostIdentity(): Promise<HostIdentityFacts> {
        return this.request<HostIdentityFacts>(
            { type: "host_identity" },
            "host_identity",
            isHostIdentity,
        );
    }

    // One page, most recently updated first. The host reports the whole listing's size as total.
    listAgents(options: ListAgentsOptions = {}): Promise<AgentListFacts> {
        const { limit = 50, order } = options;
        return this.request<AgentListFacts>(
            { type: "list_agents", limit, ...(order === undefined ? {} : { order }) },
            "agent_list",
            isAgentList,
        );
    }

    feed(chunk: string): void {
        if (this.failed !== undefined) return;
        this.buffered += chunk;
        for (;;) {
            const newline = this.buffered.indexOf("\n");
            if (newline === -1) {
                if (this.buffered.length > MAX_FRAME_BYTES) {
                    this.fail(new Error("The host sent a frame larger than this client accepts."));
                }
                return;
            }
            const line = this.buffered.slice(0, newline);
            this.buffered = this.buffered.slice(newline + 1);
            if (line.trim().length > 0) this.dispatch(line);
        }
    }

    failAll(reason: string): void {
        this.fail(new Error(reason));
    }

    private request<T>(
        payload: { readonly type: string; readonly [key: string]: unknown },
        expected: string,
        validate: (value: unknown) => value is T,
    ): Promise<T> {
        if (this.failed !== undefined) return Promise.reject(this.failed);
        const existing = this.pending.get(expected);
        if (existing !== undefined) return existing.promise as Promise<T>;
        const slot = deferred();
        const timer = setTimeout(() => {
            this.pending.delete(expected);
            slot.reject(new Error(`The host did not answer ${expected} in time.`));
        }, RESPONSE_TIMEOUT_MS);
        const promise = slot.promise.then((value) => {
            if (!validate(value)) {
                throw new Error(`The host returned an invalid ${expected} response.`);
            }
            return value;
        });
        this.pending.set(expected, {
            expected,
            promise,
            resolve: slot.resolve,
            reject: slot.reject,
            timer,
        });
        this.sendFrame(`${JSON.stringify(payload)}\n`);
        return promise;
    }

    private dispatch(line: string): void {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            this.fail(new Error("The host sent a frame that is not JSON."));
            return;
        }
        const type = (value as { type?: unknown } | null)?.type;
        if (typeof type !== "string") return;
        const pending = this.pending.get(type);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(type);
        pending.resolve(value);
    }

    private fail(error: Error): void {
        if (this.failed !== undefined) return;
        this.failed = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}

function isHostIdentity(value: unknown): value is HostIdentityFacts {
    if (typeof value !== "object" || value === null) return false;
    const identity = value as Record<string, unknown>;
    return identity.type === "host_identity"
        && typeof identity.pid === "number"
        && Number.isSafeInteger(identity.pid)
        && typeof identity.protocol_version === "number";
}

function isAgentList(value: unknown): value is AgentListFacts {
    if (typeof value !== "object" || value === null) return false;
    const list = value as Record<string, unknown>;
    return list.type === "agent_list"
        && Array.isArray(list.agents)
        && (list.total === undefined
            || (typeof list.total === "number" && Number.isSafeInteger(list.total)))
        && (list.next_cursor === undefined || typeof list.next_cursor === "string");
}

// A page with more rows behind it and no total has no honest count.
export function sessionCount(list: AgentListFacts): number | undefined {
    if (list.total !== undefined) return list.total;
    return list.next_cursor === undefined ? list.agents.length : undefined;
}
