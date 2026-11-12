import { VeraConfigError } from "../../src/config.ts";
import { BootFailedError } from "../../src/host/boot.ts";
import { HostEnvironmentFileError } from "../../src/host/host-environment.ts";
import {
    HostBuildMismatchError,
    HostLockUnreadableError,
    HostProtocolMismatchError,
    HostUnresponsiveError,
} from "../../src/host/lockfile.ts";
import {
    HostHomeUnusableError,
    HostSocketPathTooLongError,
} from "../../src/host/startup-failure.ts";
import { VERA_HOME_ENV, VeraProfileError } from "../../src/profile-paths.ts";
import { RetainedReleaseMissingError } from "../../src/release/dispatch-error.ts";
import { HostBootLoopError } from "../host/boot-failures.ts";
import { configRows } from "./config-card.ts";
import { configFixParts } from "./config-recovery.ts";
import { renderCliFailure } from "./failure.ts";
import type { StartupCard } from "./startup-card.ts";

const TITLE = "Vera can't start";

/**
 * The card for an error that stops Vera before its screen opens, or undefined
 * for any other failure, which stays a plain line.
 */
export function failureCard(error: unknown): StartupCard | undefined {
    if (error instanceof VeraConfigError) return configFailureCard(error);
    if (error instanceof HostSocketPathTooLongError) {
        return {
            kind: "error",
            title: TITLE,
            rows: [
                { label: "home", value: error.home },
                {
                    label: "reason",
                    value: `the path is ${error.homeLength} characters; on ${error.platform}`
                        + ` a home can be at most ${error.homeLimit}`,
                },
            ],
            body: [
                "Start Vera with a shorter home, for example:",
                "",
                { command: `${VERA_HOME_ENV}=${error.suggestedHome} vera` },
                "",
                "Nothing in this home was moved or deleted.",
            ],
        };
    }
    if (error instanceof HostEnvironmentFileError) {
        return {
            kind: "error",
            title: TITLE,
            rows: [
                { label: "file", value: error.path },
                { label: "line", value: String(error.line) },
                { label: "reason", value: error.reason },
            ],
            body: [
                "The host starts with the variables in this file. Each line is NAME=value,"
                    + " a # comment, or blank. Fix that line and start Vera again.",
            ],
        };
    }
    if (error instanceof HostHomeUnusableError) {
        return {
            kind: "error",
            title: TITLE,
            rows: [
                { label: "folder", value: error.home },
                { label: "reason", value: error.reason },
            ],
            body: [
                "Fix that, or start Vera from another home, for example:",
                "",
                { command: `${VERA_HOME_ENV}=${error.suggestedHome} vera` },
            ],
        };
    }
    if (error instanceof HostBootLoopError) {
        return {
            kind: "error",
            title: TITLE,
            rows: error.startupCause === undefined
                ? []
                : [{ label: "reason", value: error.startupCause }],
            body: [
                `The resident host exited during startup ${error.count} times in a row; not respawning it.`,
                "Fix the host build, then retry. Run 'vera host stop --force' after you fix the build.",
            ],
        };
    }
    if (error instanceof BootFailedError) {
        return {
            kind: "error",
            title: TITLE,
            rows: [{ label: "reason", value: error.reason }],
            body: ["Vera could not start a host."],
        };
    }
    if (
        error instanceof VeraProfileError
        || error instanceof HostUnresponsiveError
        || error instanceof HostProtocolMismatchError
        || error instanceof HostBuildMismatchError
        || error instanceof HostLockUnreadableError
        || error instanceof RetainedReleaseMissingError
    ) {
        return { kind: "error", title: TITLE, body: renderCliFailure(error).split("\n") };
    }
    return undefined;
}

function configFailureCard(error: VeraConfigError): StartupCard {
    const fix = configFixParts(error);
    return {
        kind: "error",
        title: TITLE,
        rows: configRows(error),
        body: [
            `Fix or remove ${error.path} and run Vera again.`,
            ...(fix === undefined
                ? []
                : ["", `To ${fix.effect}, run:`, "", { command: fix.command }]),
        ],
    };
}
