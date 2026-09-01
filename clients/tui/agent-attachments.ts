export interface TuiAgentAttachment {
    readonly agentId: string;
    detach(): Promise<void>;
}

export type TuiAgentPane = "main" | "sidebar";

export class TuiAgentAttachments<Attachment extends TuiAgentAttachment> {
    private mainAttachment: Attachment;
    private sidebarAttachment: Attachment | undefined;
    private focusedPane: TuiAgentPane = "main";

    constructor(main: Attachment) {
        this.mainAttachment = main;
    }

    main(): Attachment {
        return this.mainAttachment;
    }

    sidebar(): Attachment | undefined {
        return this.sidebarAttachment;
    }

    focused(): Attachment {
        return this.focusedPane === "sidebar"
            ? this.sidebarAttachment ?? this.mainAttachment
            : this.mainAttachment;
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

    async openSidebar(attachment: Attachment): Promise<void> {
        if (attachment.agentId === this.mainAttachment.agentId) {
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

    async openMain(attachment: Attachment): Promise<void> {
        if (attachment.agentId === this.sidebarAttachment?.agentId) {
            this.focusedPane = "sidebar";
            return;
        }
        if (attachment.agentId === this.mainAttachment.agentId) {
            this.focusedPane = "main";
            return;
        }
        await this.mainAttachment.detach();
        this.mainAttachment = attachment;
        this.focusedPane = "main";
    }

    async openFocused(attachment: Attachment): Promise<void> {
        if (this.focusedPane === "sidebar") {
            await this.openSidebar(attachment);
            return;
        }
        await this.openMain(attachment);
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
