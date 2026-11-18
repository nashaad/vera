import { launcherPath, runningInstallPrefix } from "../../src/release/layout.ts";
import { veraHomeDirectory } from "../../src/profile-paths.ts";
import {
    checkForUpdate,
    readUpdateMode,
    runUpdate,
    shouldCheckNow,
} from "../shared/updates.ts";
import type { TuiUpdateDependencies } from "./update-state.ts";

export interface TuiUpdateCommand {
    readonly veraCommand: string;
    readonly home: string;
    readonly env?: Record<string, string | undefined>;
    readonly tickMs?: number;
}

export function createTuiUpdates(command: TuiUpdateCommand): TuiUpdateDependencies {
    const options = {
        veraCommand: command.veraCommand,
        ...(command.env === undefined ? {} : { env: command.env }),
    };
    return {
        mode: () => readUpdateMode(command.home),
        check: () => checkForUpdate(options),
        run: (downloadOnly, onProgress) => runUpdate({ ...options, downloadOnly }, onProgress),
        shouldCheckNow,
        ...(command.tickMs === undefined ? {} : { tickMs: command.tickMs }),
    };
}

// A source checkout or dev instance has no installed launcher to update.
export function installedTuiUpdates(): TuiUpdateDependencies | undefined {
    const prefix = runningInstallPrefix();
    if (prefix === undefined) return undefined;
    return createTuiUpdates({ veraCommand: launcherPath(prefix), home: veraHomeDirectory() });
}
