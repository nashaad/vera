// Lets a test end this process between two steps the way a crash would. Does nothing unless the variable names the step.
export function exitAt(step: string): void {
    if (process.env.VERA_UPDATE_EXIT_AT === step) process.kill(process.pid, "SIGKILL");
}
