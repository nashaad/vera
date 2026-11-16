/**
 * The environment a wrapped command may see: the caller's, plus what srt
 * added or changed, and nothing else. srt answers with this process's own
 * environment on macOS and Linux, which is wider than a caller's list (a
 * skill script gets an allowlist), so the two are compared by value.
 */
export function mergeSandboxEnvironment(
    caller: Readonly<Record<string, string | undefined>>,
    wrapped: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [name, value] of Object.entries(caller)) {
        if (value !== undefined) merged[name] = value;
    }
    for (const [name, value] of Object.entries(wrapped ?? {})) {
        if (value !== undefined && process.env[name] !== value) {
            merged[name] = value;
        }
    }
    return merged;
}
