import {
    loadTuiPersistedAgentPane,
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
    readonly loadPane?: (mainAgentId: string) => TuiPersistedAgentPane | undefined;
}

export interface TuiRestorableAgentClient {
    detach(): Promise<void>;
    close(): void;
}

export interface TuiHostedPaneRestoreOptions<Client extends TuiRestorableAgentClient> {
    attach(agentId: string): Promise<Client>;
    isCurrent(): boolean;
    adopt(saved: TuiPersistedAgentPane, client: Client): Promise<void>;
}

export interface TuiHostedPaneSnapshot {
    readonly mainAgentId?: string;
    readonly sidebarAgentId?: string;
    readonly owner?: string;
    readonly mention?: string;
    readonly statusLabel?: string;
    readonly attachmentLifetime: "ephemeral" | "durable";
}

export class TuiHostedPanePersistence {
    private groupsValue: readonly TuiSharedSessionGroup[];
    private readonly saveGroups: NonNullable<
        TuiHostedPanePersistenceOptions["saveGroups"]
    >;
    private readonly savePane: NonNullable<
        TuiHostedPanePersistenceOptions["savePane"]
    >;
    private readonly loadPane: NonNullable<
        TuiHostedPanePersistenceOptions["loadPane"]
    >;

    constructor(options: TuiHostedPanePersistenceOptions = {}) {
        this.groupsValue = options.groups ?? loadTuiSharedSessionGroups();
        this.saveGroups = options.saveGroups ?? saveTuiSharedSessionGroups;
        this.savePane = options.savePane ?? saveTuiPersistedAgentPane;
        this.loadPane = options.loadPane ?? loadTuiPersistedAgentPane;
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
        }
    }

    forget(mainAgentId: string | undefined): void {
        if (mainAgentId === undefined) return;
        try {
            this.savePane(mainAgentId, undefined);
        } catch {
        }
    }

    async restore<Client extends TuiRestorableAgentClient>(
        mainAgentId: string | undefined,
        options: TuiHostedPaneRestoreOptions<Client>,
    ): Promise<boolean> {
        if (mainAgentId === undefined) return false;
        const saved = this.loadPane(mainAgentId);
        if (saved === undefined || saved.mainAgentId !== mainAgentId) return false;
        try {
            const next = await options.attach(saved.sidebarAgentId);
            if (!options.isCurrent()) {
                await next.detach().catch(() => next.close());
                return false;
            }
            await options.adopt(saved, next);
            return true;
        } catch (error) {
            this.forget(mainAgentId);
            throw error;
        }
    }
}
