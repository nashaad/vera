export interface TuiAgentAttachment {
    readonly agentId: string;
    detach(): Promise<void>;
}

export type TuiAgentPane = "main" | "sidebar";

/**
 * The two agent connections one TUI may keep open at once.
 *
 * This owns attachment membership and focus, not rendering or agent
 * lifecycle. Removing an attachment asks the host to detach this client; it
 * never closes or terminates the underlying agent.
 */
export class TuiAgentAttachments<Attachment extends TuiAgentAttachment> {
    readonly main: Attachment;
    private sidebarAttachment: Attachment | undefined;
    private focusedPane: TuiAgentPane = "main";

    constructor(main: Attachment) {
        this.main = main;
    }

    sidebar(): Attachment | undefined {
        return this.sidebarAttachment;
    }

    focused(): Attachment {
        return this.focusedPane === "sidebar"
            ? this.sidebarAttachment ?? this.main
            : this.main;
    }

    focus(): TuiAgentPane {
        return this.focusedPane;
    }

    select(pane: TuiAgentPane): void {
        this.focusedPane = pane === "sidebar"
                && this.sidebarAttachment !== undefined
            ? "sidebar"
            : "main";
    }

    /**
     * Opens one secondary attachment. Replacing it detaches the old client
     * first, so the TUI never owns three agent connections between awaits.
     */
    async openSidebar(attachment: Attachment): Promise<void> {
        if (attachment.agentId === this.main.agentId) {
            await this.detachSidebar();
            this.focusedPane = "main";
            return;
        }
        if (attachment.agentId === this.sidebarAttachment?.agentId) {
            this.focusedPane = "sidebar";
            return;
        }
        await this.detachSidebar();
        this.sidebarAttachment = attachment;
        this.focusedPane = "sidebar";
    }

    async detachSidebar(): Promise<void> {
        const attachment = this.sidebarAttachment;
        if (attachment === undefined) {
            return;
        }
        await attachment.detach();
        this.sidebarAttachment = undefined;
        this.focusedPane = "main";
    }
}
