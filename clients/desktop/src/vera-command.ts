import { accessSync, constants, existsSync } from "node:fs";

import { launcherPath } from "../../../src/release/layout.ts";

export interface BootCommand {
    readonly command: string;
    readonly args: readonly string[];
    readonly label: string;
}

export interface MissingBootCommand {
    readonly message: string;
    readonly checked: readonly string[];
}

export type BootCommandResolution =
    | { readonly command: BootCommand }
    | { readonly missing: MissingBootCommand };

export function resolveBootCommand(
    env: NodeJS.ProcessEnv = process.env,
): BootCommandResolution {
    const devEntry = env.VERA_DESKTOP_DEV_CLI?.trim();
    if (devEntry !== undefined && devEntry.length > 0) {
        if (!existsSync(devEntry)) {
            return {
                missing: {
                    message: "The development Vera CLI was not found.",
                    checked: [devEntry],
                },
            };
        }
        const bun = env.VERA_DESKTOP_BUN?.trim();
        return {
            command: {
                command: bun !== undefined && bun.length > 0 ? bun : "bun",
                args: [devEntry, "boot", "--json"],
                label: devEntry,
            },
        };
    }

    const launcher = launcherPath();
    if (isExecutable(launcher)) {
        return {
            command: {
                command: launcher,
                args: ["boot", "--json"],
                label: launcher,
            },
        };
    }
    return {
        missing: {
            message: "Vera is not installed. Install Vera, then choose Reconnect.",
            checked: [launcher],
        },
    };
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
