import type { TelemetryEvent } from "../events.ts";
import type { TelemetrySink } from "./sink.ts";

export interface AxiomSinkOptions {
    /** Base domain of the edge deployment, without a trailing slash. */
    readonly url: string;
    readonly dataset: string;
    readonly token: string;
    /** Tests replace this; the host uses the global fetch. */
    readonly fetch?: typeof fetch;
}

/** A send that hangs must not hold the queue forever. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * Axiom's edge ingest endpoint is `POST {base}/v1/ingest/{dataset}`; the
 * legacy `/v1/datasets/{dataset}/ingest` path is not served by edge
 * deployments. Without `timestamp-field`, Axiom stamps receipt time, so the
 * sink names `_time` and maps the event time onto it.
 */
export function axiomSink(options: AxiomSinkOptions): TelemetrySink {
    const endpoint = new URL(
        `${options.url.replace(/\/+$/, "")}/v1/ingest/${encodeURIComponent(options.dataset)}`,
    );
    endpoint.searchParams.set("timestamp-field", "_time");
    const post = options.fetch ?? fetch;
    return {
        async send(events) {
            if (events.length === 0) return;
            const response = await post(endpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${options.token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(events.map(axiomEvent)),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`Axiom ingest failed with status ${response.status}`);
            }
        },
    };
}

function axiomEvent(event: TelemetryEvent): Record<string, unknown> {
    const { time, ...rest } = event;
    return { _time: time, ...rest };
}
