import type { TelemetryEvent } from "../events.ts";

/**
 * One way out of the host. A sink maps the vendor-neutral event to its own
 * wire shape; event building, batching and the cache-miss rule never see it.
 */
export interface TelemetrySink {
    send(events: readonly TelemetryEvent[]): Promise<void>;
}
