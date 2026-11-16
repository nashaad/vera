import { join } from "node:path";

/**
 * A project's Vera settings file. The skill, agent and inbox readers all open
 * this one path; the sandbox denies writes to it.
 */
export function projectVeraConfigPath(projectRoot: string): string {
    return join(projectRoot, ".vera", "config.json");
}

/** A project's rules directory; the sandbox denies writes beneath it. */
export function projectRulesDirectory(projectRoot: string): string {
    return join(projectRoot, ".vera", "rules");
}
