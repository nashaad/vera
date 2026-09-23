// OSC 9;4 asks the terminal to draw its own busy bar. Terminals without it may
// show the payload as a notification, so only known supporters get it.
export const TERMINAL_PROGRESS_BUSY = "\u001b]9;4;3\u001b\\";
export const TERMINAL_PROGRESS_CLEAR = "\u001b]9;4;0\u001b\\";

// Resent while busy so a terminal that expires stale progress keeps the bar.
const BUSY_RESEND_MS = 5_000;

type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

export function terminalSupportsProgress(env: TerminalEnvironment, isTTY: boolean): boolean {
    if (!isTTY) return false;
    if (env.WT_SESSION !== undefined) return false;
    if (env.ConEmuANSI !== undefined || env.ConEmuPID !== undefined || env.ConEmuTask !== undefined) {
        return true;
    }
    const version = env.TERM_PROGRAM_VERSION;
    if (version === undefined) return false;
    if (env.TERM_PROGRAM === "ghostty") return versionAtLeast(version, [1, 2, 0]);
    if (env.TERM_PROGRAM === "iTerm.app") return versionAtLeast(version, [3, 6, 6]);
    return false;
}

function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (match === null) return false;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    for (let index = 0; index < minimum.length; index += 1) {
        if (parts[index]! !== minimum[index]!) return parts[index]! > minimum[index]!;
    }
    return true;
}

export interface TerminalProgressState {
    readonly busy: boolean;
    readonly sentAt: number;
}

export interface TerminalProgressStep {
    readonly state: TerminalProgressState;
    readonly sequence?: string;
}

export const TERMINAL_PROGRESS_IDLE: TerminalProgressState = { busy: false, sentAt: 0 };

export function stepTerminalProgress(
    previous: TerminalProgressState,
    busy: boolean,
    now: number,
): TerminalProgressStep {
    if (busy) {
        if (previous.busy && now - previous.sentAt < BUSY_RESEND_MS) return { state: previous };
        return { state: { busy: true, sentAt: now }, sequence: TERMINAL_PROGRESS_BUSY };
    }
    if (!previous.busy) return { state: previous };
    return { state: { busy: false, sentAt: now }, sequence: TERMINAL_PROGRESS_CLEAR };
}
