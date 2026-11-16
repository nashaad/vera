import type { DesktopFileFilter } from "../../../ui/src/extensions/manifest.ts";
import type { ExtensionCommandResult } from "../../../ui/src/protocol/extension-commands.ts";
import type { CommandTarget } from "../extensions/store.ts";
import type { ThemeService } from "../theme-service.ts";
import type { CommandReply, CommandTask, JsonValue } from "./task-protocol.ts";

// Everything outside main's own state that running a command needs.
export interface CommandHost {
    target(command: string): CommandTarget | undefined;
    run(target: CommandTarget, task: CommandTask): Promise<CommandReply>;
    chooseFile(filter: DesktopFileFilter): Promise<string | undefined>;
}

const UNAVAILABLE = "Vera could not import that theme.";
const STALE_PICK = "That theme is not in the list. Open the list again.";
const PICK_KEY = /^pick-\d{1,4}$/;

// Runs the commands of enabled included extensions, one task process per run. A list a task sends back is held
// here as it came, unread, and the window gets only keys, labels and details. Choosing an item sends its value back.
export class ExtensionCommandService {
    // The values of each command's last list, replaced when the command lists again.
    private readonly picks = new Map<string, ReadonlyMap<string, JsonValue>>();

    constructor(
        private readonly host: CommandHost,
        private readonly themes: ThemeService,
    ) {}

    async run(command: string, key?: string): Promise<ExtensionCommandResult> {
        const target = this.host.target(command);
        if (target === undefined) return { ok: false, reason: UNAVAILABLE };
        const task = await this.taskFor(command, target, key);
        if ("ok" in task) return task;
        const reply = await this.host.run(target, task);
        if (reply.kind === "refused") return { ok: false, reason: reply.reason };
        if (reply.kind === "themes") return this.themes.install(reply.themes, reply.skipped);
        const values = new Map<string, JsonValue>();
        const items = reply.items.map((item, index) => {
            const itemKey = `pick-${index}`;
            values.set(itemKey, item.value);
            return { key: itemKey, label: item.label, ...(item.detail === undefined ? {} : { detail: item.detail }) };
        });
        this.picks.set(command, values);
        return { ok: true, kind: "pick", title: reply.title, items, cut: reply.cut };
    }

    // The task to run, or the answer to give instead when nothing runs.
    private async taskFor(command: string, target: CommandTarget, key: string | undefined): Promise<CommandTask | ExtensionCommandResult> {
        if (key !== undefined) {
            const value = PICK_KEY.test(key) ? this.picks.get(command)?.get(key) : undefined;
            return value === undefined ? { ok: false, reason: STALE_PICK } : { command, pick: value };
        }
        if (target.file === undefined) return { command };
        const file = await this.host.chooseFile(target.file);
        // Closing the picker without choosing runs nothing and reports nothing.
        if (file === undefined) return { ok: true, kind: "themes", imported: [], themes: this.themes.themes(), skipped: [] };
        return { command, file };
    }
}
