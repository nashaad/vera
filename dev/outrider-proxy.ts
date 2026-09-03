/** A stand-in for Outrider's gateway: its wire surface in front of whatever local runtime is actually up. */

const OUTRIDER_PORT = 11435;

const OLLAMA_PORT = 11434;

/** Outrider claims 11434-11440 for its own backends, so the stand-in listens clear of that range. */
const DEFAULT_PORT = 11450;

const PROXIED_PATHS = [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/responses",
];

interface OutriderModel {
    readonly id: string;
    readonly object: "model";
    readonly owned_by: "outrider";
    readonly quantization?: string;
    readonly meta: {
        readonly n_ctx: number;
        readonly n_ctx_train?: number;
    };
}

interface Upstream {
    /** What this stand-in is speaking to, for the line it prints and the header it sets. */
    readonly name: string;
    readonly base: string;
    readonly models: readonly OutriderModel[];
}

function errorBody(message: string): string {
    return JSON.stringify({
        error: { message, type: "outrider_model_error" },
    });
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function failure(message: string, status: number): Response {
    return new Response(errorBody(message), {
        status,
        headers: { "content-type": "application/json" },
    });
}

async function fetchJson(url: string, timeoutMs = 2000): Promise<unknown> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return await response.json();
}

/** The real gateway, when it is up. Its list is already in the shape this serves. */
async function outriderUpstream(): Promise<Upstream | undefined> {
    const base = `http://127.0.0.1:${OUTRIDER_PORT}`;
    try {
        await fetchJson(`${base}/health`);
        const listed = await fetchJson(`${base}/v1/models`) as {
            data?: readonly OutriderModel[];
        };
        return { name: "outrider", base, models: listed.data ?? [] };
    } catch {
        return undefined;
    }
}

/** Ollama's tags carry the quantization and context that Outrider's list reports. */
async function ollamaUpstream(): Promise<Upstream | undefined> {
    const base = `http://127.0.0.1:${OLLAMA_PORT}`;
    try {
        const tags = await fetchJson(`${base}/api/tags`) as {
            models?: readonly {
                model?: string;
                name?: string;
                details?: {
                    quantization_level?: string;
                    context_length?: number;
                };
            }[];
        };
        const models = (tags.models ?? []).flatMap((entry) => {
            const id = entry.model ?? entry.name;
            if (id === undefined) return [];
            const context = entry.details?.context_length ?? 0;
            const quantization = entry.details?.quantization_level;
            return [{
                id,
                object: "model" as const,
                owned_by: "outrider" as const,
                ...(quantization === undefined ? {} : { quantization }),
                meta: { n_ctx: context, n_ctx_train: context },
            }];
        });
        return { name: "ollama", base: `${base}/v1`, models };
    } catch {
        return undefined;
    }
}

/** The real gateway first. Ollama is the fallback, so the stand-in keeps answering when the gateway is not built. */
async function resolveUpstream(): Promise<Upstream | undefined> {
    return await outriderUpstream() ?? await ollamaUpstream();
}

let upstream: Upstream | undefined;

async function currentUpstream(): Promise<Upstream | undefined> {
    if (upstream !== undefined) return upstream;
    upstream = await resolveUpstream();
    if (upstream !== undefined) {
        console.log(
            `[outrider-proxy] upstream ${upstream.name} at ${upstream.base}, `
                + `${upstream.models.length} models`,
        );
    }
    return upstream;
}

async function proxyModelRequest(request: Request): Promise<Response> {
    const body = await request.text();
    let model = "";
    try {
        model = (JSON.parse(body) as { model?: string }).model ?? "";
    } catch {
        return failure("request must name a model", 400);
    }
    if (model.trim() === "") {
        return failure("request must name a model", 400);
    }
    const active = await currentUpstream();
    if (active === undefined) {
        return failure("no local runtime is listening", 503);
    }
    if (!active.models.some((entry) => entry.id === model)) {
        return failure(`unknown model "${model}"`, 404);
    }
    const path = new URL(request.url).pathname;
    let response: Response;
    try {
        response = await fetch(`${active.base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
    } catch (error) {
        // A dead upstream is re-resolved on the next request rather than held.
        upstream = undefined;
        const detail = error instanceof Error ? error.message : String(error);
        return failure(`model backend failed: ${detail}`, 502);
    }
    const headers = new Headers(response.headers);
    headers.set("X-Outrider-Model", model);
    headers.set("X-Outrider-Upstream", active.name);
    return new Response(response.body, { status: response.status, headers });
}

async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
        const active = await currentUpstream();
        if (active === undefined) {
            return failure("no local runtime is listening", 503);
        }
        return json({ status: "ok" });
    }
    if (request.method === "GET" && path === "/v1/models") {
        const active = await currentUpstream();
        if (active === undefined) {
            return failure("no local runtime is listening", 503);
        }
        return json({ object: "list", data: active.models });
    }
    if (request.method === "POST" && PROXIED_PATHS.includes(path)) {
        return await proxyModelRequest(request);
    }
    return failure(`no route for ${request.method} ${path}`, 404);
}

function requestedPort(argv: readonly string[]): number {
    const at = argv.indexOf("--port");
    if (at === -1) return DEFAULT_PORT;
    const value = Number(argv[at + 1]);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT;
}

const port = requestedPort(Bun.argv.slice(2));
Bun.serve({ port, hostname: "127.0.0.1", fetch: handle });
console.log(`[outrider-proxy] listening on http://127.0.0.1:${port}`);
void currentUpstream();

export {};
