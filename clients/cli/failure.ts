import { VeraConfigError } from "../../src/config.ts";
import {
    HostBuildMismatchError,
    HostLockUnreadableError,
    HostProtocolMismatchError,
    HostUnresponsiveError,
} from "../../src/host/lockfile.ts";
import { VeraProfileError } from "../../src/profile-paths.ts";
import { RetainedReleaseMissingError } from "../../src/release/dispatch-error.ts";

export function renderCliFailure(error: unknown): string {
    if (error instanceof VeraProfileError) {
        return error.message;
    }
    if (error instanceof HostUnresponsiveError) {
        return `${error.message}\n`
            + "Run 'vera host stop --force' to kill it.";
    }
    if (error instanceof HostProtocolMismatchError) {
        return `Vera host upgrade required: ${error.message}\n`
            + "Close the older Vera client and retry, or run 'vera host stop'.";
    }
    if (error instanceof HostBuildMismatchError) {
        return error.message;
    }
    if (error instanceof HostLockUnreadableError) {
        return error.message;
    }
    if (error instanceof RetainedReleaseMissingError) {
        return error.message;
    }
    if (error instanceof VeraConfigError) {
        return `${error.message}\n`
            + `Fix or remove ${error.path} and run Vera again.`;
    }
    return `Vera failed: ${
        error instanceof Error ? error.message : String(error)
    }`;
}
