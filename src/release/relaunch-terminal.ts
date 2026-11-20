import { writeSync } from "node:fs";

import { removeRelaunchRecord } from "./relaunch.ts";
import { TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE } from "../terminal-restore-sequence.ts";

export function restoreUnclaimedRelaunchTerminal(
    launcherKey: string,
    tty: { readonly fd: number; readonly isTTY?: boolean } = process.stdout,
): void {
    if (!removeRelaunchRecord(launcherKey)) return;
    if (tty.isTTY === true) writeSync(tty.fd, TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE);
}
