export type TuiSessionLeaveDisposition = "stop" | "keep_running";

export interface TuiSessionLeaveResult {
    readonly sourceOutcome: "detached" | "stopped";
    readonly remainingInteractiveClients: number;
}
