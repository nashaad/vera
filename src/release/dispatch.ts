import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

import {
    createHostLockfile,
    HostBuildMismatchError,
} from "../host/lockfile.ts";
import {
    defaultInstallPrefix,
    RELEASE_CLI_NAME,
    releaseDirectory,
} from "./layout.ts";
import { thisProcessBuildId } from "./stamp.ts";

export const RETAINED_DISPATCH_ENV = "VERA_RETAINED_DISPATCH";

export class RetainedReleaseMissingError extends Error {
    constructor(
        readonly clientBuildId: string,
        readonly hostBuildId: string,
        readonly releasePath: string,
    ) {
        super(
            `This client is ${clientBuildId}; the resident host is ${hostBuildId}. `
                + `That release is not retained at ${releasePath}. `
                + "They cannot attach. Stop the host with 'vera host stop' "
                + "so the activated build can start, or run 'vera rollback'.",
        );
        this.name = "RetainedReleaseMissingError";
    }
}

export interface DispatchOptions {
    readonly prefix?: string;
    readonly argv?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly clientBuildId?: string;
    readonly inspectHost?: () => Promise<string | undefined>;
    readonly exec?: (
        clientPath: string,
        argv: readonly string[],
        env: NodeJS.ProcessEnv,
    ) => Promise<number>;
}

export async function dispatchToHostRelease(
    options: DispatchOptions = {},
): Promise<number | undefined> {
    return resolve(options, false);
}

async function resolve(
    options: DispatchOptions,
    retried: boolean,
): Promise<number | undefined> {
    const env = options.env ?? process.env;
    const prefix = options.prefix ?? defaultInstallPrefix();
    const clientBuildId = options.clientBuildId ?? thisProcessBuildId();
    const inspect = options.inspectHost ?? inspectLiveHostBuild;
    const exec = options.exec ?? execRetainedClient;
    const argv = options.argv ?? process.argv.slice(2);

    const hostBuildId = await inspect();
    if (hostBuildId === undefined || hostBuildId === clientBuildId) {
        return undefined;
    }

    const alreadyDispatched = env[RETAINED_DISPATCH_ENV] !== undefined;
    const clientPath = retainedClientPath(hostBuildId, prefix);

    if (alreadyDispatched) {
        if (!retried) {
            return resolve(options, true);
        }
        if (clientPath === undefined) {
            throw new RetainedReleaseMissingError(
                clientBuildId,
                hostBuildId,
                releaseDirectory(hostBuildId, prefix),
            );
        }
        throw new HostBuildMismatchError(clientBuildId, hostBuildId);
    }

    if (clientPath === undefined) {
        throw new RetainedReleaseMissingError(
            clientBuildId,
            hostBuildId,
            releaseDirectory(hostBuildId, prefix),
        );
    }

    if (!retried) {
        const again = await inspect();
        if (again !== hostBuildId) {
            return resolve(options, true);
        }
    }

    const childEnv = { ...env, [RETAINED_DISPATCH_ENV]: "1" };
    return exec(clientPath, argv, childEnv);
}

export function retainedClientPath(
    buildId: string,
    prefix = defaultInstallPrefix(),
): string | undefined {
    const path = join(releaseDirectory(buildId, prefix), RELEASE_CLI_NAME);
    try {
        accessSync(path, constants.X_OK);
        return path;
    } catch {
        return undefined;
    }
}

async function inspectLiveHostBuild(): Promise<string | undefined> {
    const record = await createHostLockfile().read();
    return record?.build_id;
}

async function execRetainedClient(
    clientPath: string,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
): Promise<number> {
    const child = spawn(clientPath, [...argv], {
        stdio: "inherit",
        env,
    });
    return await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            resolve(signal !== null ? 1 : code ?? 0);
        });
    });
}
