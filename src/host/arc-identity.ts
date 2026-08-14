import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The arc identity this host's sessions post under.
 *
 * arc stamps every event with the posting node's id as `actor` and the value
 * of `ARC_SESSION` in the posting shell as `session`. The host attaches each
 * interactive session to the inbox with its minted identity name as the
 * session half of the self-echo pair, so the node id read here is the actor
 * half that completes the pair. Without it the pair stays half-null and
 * self-echo suppression never arms.
 */

const NODE_ID_LINE = /^\s*node_id\s*=\s*"([^"]*)"\s*(?:#.*)?$/;
const TOKEN_LINE = /^\s*token\s*=\s*"([^"]*)"\s*(?:#.*)?$/;

/** `$ARC_CONFIG` when set, else arc's default per-user config path. */
export function defaultArcConfigPath(): string {
    const override = process.env.ARC_CONFIG;
    if (override !== undefined && override !== "") {
        return override;
    }
    return join(homedir(), ".config", "arc", "config.toml");
}

/**
 * The `node_id` from arc's config file, `null` when the file is missing,
 * unreadable, or carries none. A host without an arc identity still runs; its
 * sessions just get no self-echo suppression on arc entries.
 */
export function readArcNodeId(
    configPath: string = defaultArcConfigPath(),
): string | null {
    return readQuotedValue(configPath, NODE_ID_LINE);
}

/**
 * The bearer `token` from arc's config file, `null` when the file is missing,
 * unreadable, or carries none. Watches use it to authenticate against the arc
 * server; a watch without one still runs, unauthenticated.
 */
export function readArcToken(
    configPath: string = defaultArcConfigPath(),
): string | null {
    return readQuotedValue(configPath, TOKEN_LINE);
}

function readQuotedValue(configPath: string, line: RegExp): string | null {
    let text: string;
    try {
        text = readFileSync(configPath, "utf8");
    } catch {
        return null;
    }
    for (const candidate of text.split("\n")) {
        const match = line.exec(candidate);
        if (match !== null && match[1] !== "") {
            return match[1]!;
        }
    }
    return null;
}
