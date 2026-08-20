/**
 * Which providers hold their model list as a snapshot, so asking again is a
 * thing that can be done.
 *
 * The others are read on every call: Ollama is a live localhost query, and
 * DeepSeek and Codex are read from disk. Their lists are already as fresh as
 * they get, so a refresh key over one of their rows would promise something
 * that cannot happen.
 *
 * Read by the host, which does the asking, and by the client, which decides
 * whether to offer the key at all. One list rather than two that drift.
 */
const REFRESHABLE_PROVIDERS: readonly string[] = ["openrouter", "cerebras"];

export function isRefreshableProvider(provider: string): boolean {
    return REFRESHABLE_PROVIDERS.includes(provider);
}
