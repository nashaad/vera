import type { VeraClientExtensionApi } from "../../src/sdk/extensions.ts";
import { readFilePatch, readWorkspaceDiff } from "./model.ts";
import { createDiffView, type DiffView } from "./view.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    let cancel: (() => void) | undefined;
    vera.conversation.onChanged(() => cancel?.());
    vera.onDispose(() => cancel?.());
    vera.commands.register({
        name: "diff",
        description: "Browse changed files and patches in this workspace",
        usage: "/diff",
        interactive: true,
        palette: { label: "View workspace diff", group: "Session" },
        async run({ argumentsText, workspace, signal }) {
            if (argumentsText.trim()) return { kind: "text", text: "Usage: /diff" };
            const controller = new AbortController();
            const abort = (): void => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            cancel = abort;
            try {
                const snapshot = await readWorkspaceDiff(workspace, controller.signal);
                controller.signal.throwIfAborted();
                let view: DiffView | undefined;
                let finish: () => void = () => {};
                const closed = new Promise<void>((resolve) => { finish = resolve; });
                controller.signal.addEventListener("abort", finish, { once: true });
                const dispose = vera.experimentalTui.mountRenderable({
                    id: "diff", slot: "overlay", modal: true, fullscreen: true,
                    create({ renderer }) { view = createDiffView(renderer, snapshot, abort); return view.root; },
                    onKey(key) { return view?.onKey(key); },
                });
                const load = async (): Promise<void> => {
                    for (let index = 0; index < snapshot.files.length; index++) {
                        if (controller.signal.aborted) break;
                        try { view?.setPatch(index, await readFilePatch(snapshot, snapshot.files[index]!, controller.signal)); }
                        catch (error) {
                            if (!controller.signal.aborted) view?.setPatch(index, `Could not load patch: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                };
                try { void load(); await closed; }
                finally { await dispose(); controller.signal.removeEventListener("abort", finish); }
            } catch (error) {
                if (!controller.signal.aborted) return { kind: "text", text: error instanceof Error ? error.message : String(error) };
            } finally {
                signal.removeEventListener("abort", abort);
                cancel = undefined;
            }
            return { kind: "handled" };
        },
    });
}
