import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the registry copies into its own mutable defaults and rewrites when the
 * user changes it in session. These are live through that write, so reading
 * them once at start is not a stale value.
 */
const START_ONLY = new Set([
    "provider",
    "model",
    "approval_mode",
    "reasoning_effort",
]);

/** The body of the registry options literal, brace-matched from its opening. */
function registryOptions(source: string): string {
    const start = source.indexOf("new AgentRegistry({");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let at = source.indexOf("{", start); at < source.length; at += 1) {
        if (source[at] === "{") depth += 1;
        if (source[at] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, at);
        }
    }
    throw new Error("the registry options literal does not close");
}

// A setting read from the config the host booted with is a setting the user
// has to restart Vera to change. Everything the registry is handed reads
// through `currentConfig()` instead, which re-reads the file, so a new setting
// added here is live by construction rather than by someone remembering.
test("no setting the registry is handed is captured at host start", () => {
    const source = readFileSync(
        join(import.meta.dir, "..", "..", "src", "host", "runtime.ts"),
        "utf8",
    );
    const captured = [
        ...registryOptions(source).matchAll(/options\.config\.?(\w*)/g),
    ]
        .map((match) => match[1] ?? "")
        .filter((key) => !START_ONLY.has(key));
    expect(captured).toEqual([]);
});
