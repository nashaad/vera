import { randomUUID } from "node:crypto";

import type {
    ExtensionChangeResult,
    ExtensionPreviewResult,
} from "../../../ui/src/protocol/extensions.ts";
import type { ThemeService } from "../theme-service.ts";
import type { InstallReply, InstallTask } from "../extension-install/task-protocol.ts";
import type { ExtensionStore } from "./store.ts";

export type RunInstallTask = (task: InstallTask) => Promise<InstallReply>;

interface Pending {
    readonly token: string;
    readonly staging: string;
}

const STALE = "That package is no longer waiting to be installed. Choose it again.";

// Desktop extensions: the list, turning them on and off, removing them, and installing a package in two steps.
// `preview` unpacks the package in a task process and keeps the staging folder; `confirm` installs it, `cancel`
// deletes it. One package waits at a time, and a new preview replaces it.
export class ExtensionService {
    private pending: Pending | undefined;

    constructor(
        private readonly store: ExtensionStore,
        private readonly themes: ThemeService,
        private readonly run: RunInstallTask,
        // Called after the set of extensions or what is turned on has changed.
        private readonly onChange: () => void = () => {},
    ) {}

    // Reads everything again, so a folder added or removed by hand shows up.
    list(): ExtensionChangeResult {
        return this.state();
    }

    async preview(path: string, sha256?: string): Promise<ExtensionPreviewResult> {
        this.cancelPending();
        this.store.clearStaging();
        const staging = this.store.newStaging();
        let reply: InstallReply;
        try {
            reply = await this.run({ kind: "install", packagePath: path, ...(sha256 === undefined ? {} : { sha256 }), staging });
        } catch {
            this.store.discard(staging);
            return { ok: false, reason: "Vera could not read that package." };
        }
        if (!reply.ok) {
            this.store.discard(staging);
            return reply;
        }
        this.cancelPending();
        const token = randomUUID();
        this.pending = { token, staging };
        const replaces = this.store.installedVersion(reply.preview.id);
        return { ok: true, preview: { token, ...reply.preview, ...(replaces === undefined ? {} : { replaces }) } };
    }

    confirm(token: string): ExtensionChangeResult {
        const pending = this.pending;
        if (pending === undefined || pending.token !== token) return { ok: false, reason: STALE };
        this.pending = undefined;
        const result = this.store.commit(pending.staging);
        if (!result.ok) {
            this.store.discard(pending.staging);
            return result;
        }
        return this.changed();
    }

    cancel(token: string): void {
        if (this.pending?.token === token) this.cancelPending();
    }

    setEnabled(id: string, enabled: boolean): ExtensionChangeResult {
        if (!this.store.setEnabled(id, enabled)) return { ok: false, reason: `Vera could not turn "${id}" ${enabled ? "on" : "off"}.` };
        return this.changed();
    }

    remove(id: string): ExtensionChangeResult {
        switch (this.store.remove(id)) {
            case "removed":
                return this.changed();
            case "included":
                return { ok: false, reason: `"${id}" is included with Vera and cannot be removed.` };
            case "missing":
                return { ok: false, reason: `"${id}" is not installed.` };
            case "failed":
                return { ok: false, reason: `Vera could not remove "${id}".` };
        }
    }

    private cancelPending(): void {
        if (this.pending !== undefined) this.store.discard(this.pending.staging);
        this.pending = undefined;
    }

    private changed(): ExtensionChangeResult {
        const result = this.state();
        this.onChange();
        return result;
    }

    private state(): ExtensionChangeResult {
        return { ok: true, extensions: this.store.entries(), themes: this.themes.load() };
    }
}
