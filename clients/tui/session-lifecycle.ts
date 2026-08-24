/** What happens to the conversation a user deliberately leaves. */
export type TuiSessionLeaveDisposition = "stop" | "keep_running";

export interface TuiSessionLeaveResult {
    readonly sourceOutcome: "detached" | "stopped";
    readonly remainingInteractiveClients: number;
}
