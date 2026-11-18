// What the app shell tells the desktop package it loaded. The package runs in the shell's process, so one global carries it.
const SHELL_KEY = Symbol.for("vera.desktop.shell");

export interface DesktopShellHandle {
    readonly shellApi: number;
    readonly prefix: string;
    readonly hostBuildId: string;
    readonly desktopVersion: string;
    // Drops the record that tells cleanup this process uses the package. Safe to call more than once.
    readonly release: () => void;
}

interface ShellGlobal {
    [SHELL_KEY]?: DesktopShellHandle;
}

export function publishDesktopShell(handle: DesktopShellHandle): void {
    (globalThis as ShellGlobal)[SHELL_KEY] = handle;
}

// Undefined when the desktop was not started by the shell, as in development.
export function runningDesktopShell(): DesktopShellHandle | undefined {
    return (globalThis as ShellGlobal)[SHELL_KEY];
}

export function clearDesktopShell(): void {
    delete (globalThis as ShellGlobal)[SHELL_KEY];
}
