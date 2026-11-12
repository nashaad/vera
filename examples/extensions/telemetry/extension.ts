import type { VeraExtensionApi } from "../../../src/sdk/extensions.ts";

import { Batcher } from "./src/batcher.ts";
import { telemetryConfig, type TelemetryConfig } from "./src/config.ts";
import { telemetryDroppedEvent, type EventContext } from "./src/events.ts";
import { readOrCreateInstallId } from "./src/install-id.ts";
import { telemetryHandlers } from "./src/middleware.ts";
import { axiomSink } from "./src/sinks/axiom.ts";
import { jsonlSink } from "./src/sinks/jsonl.ts";
import type { TelemetrySink } from "./src/sinks/sink.ts";

export function activate(vera: VeraExtensionApi): void {
    const config = telemetryConfig(vera.config);
    if (config === null) return;

    const installId = readOrCreateInstallId(vera.storage.profile);
    const context: EventContext = {
        install_id: installId,
        ...(config.developer === undefined ? {} : { developer: config.developer }),
    };
    const batcher = new Batcher(sinkFor(config, vera.storage.profile), {
        flushSeconds: config.flushSeconds,
        dropped: (count) => telemetryDroppedEvent(context, count, new Date().toISOString()),
    });
    const handlers = telemetryHandlers({
        context,
        cacheMiss: config.cacheMiss,
        emit: (event) => batcher.push(event),
    });

    vera.hooks.registerModelMiddleware(handlers.middleware);
    if (typeof vera.hooks.registerSessionEnd === "function") {
        vera.hooks.registerSessionEnd((payload) => {
            handlers.sessionEnded(payload);
            // The host does not await this hook, so the send outlives the call.
            void batcher.flush();
        });
    }
    batcher.start();
    if (typeof vera.onDispose === "function") {
        vera.onDispose(() => batcher.stop());
    }
}

function sinkFor(config: TelemetryConfig, profile: string): TelemetrySink {
    if (config.sink.type === "axiom") {
        return axiomSink({
            url: config.sink.url,
            dataset: config.sink.dataset,
            token: config.sink.token,
        });
    }
    return jsonlSink(profile);
}
