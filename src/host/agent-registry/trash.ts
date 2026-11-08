import type { RegisteredAgentKind } from "./support.ts";

export interface TrashRestartPlan {
    readonly id: string;
    readonly sessionPath: string;
    readonly kind: RegisteredAgentKind;
    readonly eventLogPath: string | undefined;
    readonly parentId: string | undefined;
    readonly parentRegistered: boolean;
    readonly completed: boolean;
}

export interface TrashReserved {
    readonly status: "reserved";
    readonly plans: readonly TrashRestartPlan[];
}

export interface TrashBusy {
    readonly status: "busy";
}

export type TrashReservation = TrashReserved | TrashBusy;
