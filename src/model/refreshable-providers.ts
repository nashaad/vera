/**
 * Which providers can be asked for their model list while a session is live.
 *
 * DeepSeek and Codex are read from disk, so their lists are already as fresh
 * as they get. Local Ollama and oMLX servers are different: the host is
 * resident after the TUI starts, so they need an explicit refresh just like
 * a remote snapshot.
 *
 * Read by the host, which does the asking, and by the client, which decides
 * whether to offer the key at all. One list rather than two that drift.
 */
import {
    resolveProviders,
    type ProviderResolutionInput,
} from "../providers/definitions.ts";

export function isRefreshableProvider(
    provider: string,
    input: ProviderResolutionInput = {},
): boolean {
    return resolveProviders(input).some((entry) =>
        entry.id === provider && entry.definition.discovery.mode === "models"
    );
}
