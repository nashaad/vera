import {
    loadTuiSharedSessionGroups,
    saveTuiPersistedAgentPane,
    saveTuiSharedSessionGroups,
    type TuiPersistedAgentPane,
} from "./theme-preference.ts";

export type TuiSharedSessionGroup = readonly [string, string];

export interface TuiHostedPanePersistenceOptions {
    readonly groups?: readonly TuiSharedSessionGroup[];
    readonly saveGroups?: (groups: readonly TuiSharedSessionGroup[]) => void;
    readonly savePane?: (
        mainAgentId: string,
        pane: TuiPersistedAgentPane | undefined,
    ) => void;
}

export interface TuiHostedPaneSnapshot {
    readonly mainAgentId?: string;
    readonly sidebarAgentId?: string;
    readonly owner?: string;
    readonly mention?: string;
    readonly statusLabel?: string;
    readonly attachmentLifetime: "ephemeral" | "durable";
}

/** Persists the durable relationship between the two visible agent panes. */
export class TuiHostedPanePersistence {
    private groupsValue: readonly TuiSharedSessionGroup[];
    private readonly saveGroups: NonNullable<
        TuiHostedPanePersistenceOptions["saveGroups"]
    >;
    private readonly savePane: NonNullable<
        TuiHostedPanePersistenceOptions["savePane"]
    >;

    constructor(options: TuiHostedPanePersistenceOptions = {}) {
        this.groupsValue = options.groups ?? loadTuiSharedSessionGroups();
        this.saveGroups = options.saveGroups ?? saveTuiSharedSessionGroups;
        this.savePane = options.savePane ?? saveTuiPersistedAgentPane;
    }

    get groups(): readonly TuiSharedSessionGroup[] {
        return this.groupsValue;
    }

    remember(snapshot: TuiHostedPaneSnapshot): void {
        const mainId = snapshot.mainAgentId;
        const sidebarId = snapshot.sidebarAgentId;
        if (mainId === undefined || sidebarId === undefined) return;
        const remaining = this.groupsValue.filter((group) =>
            !group.includes(mainId) && !group.includes(sidebarId)
        );
        this.groupsValue = snapshot.attachmentLifetime === "ephemeral"
            ? remaining
            : [...remaining, [mainId, sidebarId]];
        try {
            this.saveGroups(this.groupsValue);
            this.savePane(
                mainId,
                snapshot.attachmentLifetime === "ephemeral"
                    ? undefined
                    : {
                        mainAgentId: mainId,
                        sidebarAgentId: sidebarId,
                        owner: snapshot.owner ?? "vera.tui.agent-attachments",
                        ...(snapshot.mention === undefined
                            ? {}
                            : { mention: snapshot.mention }),
                        ...(snapshot.statusLabel === undefined
                            ? {}
                            : { statusLabel: snapshot.statusLabel }),
                    },
            );
        } catch {
            // UI preference writes cannot prevent an attachment.
        }
    }

    forget(mainAgentId: string | undefined): void {
        if (mainAgentId === undefined) return;
        try {
            this.savePane(mainAgentId, undefined);
        } catch {
            // Preference cleanup cannot block closing a pane.
        }
    }
}
