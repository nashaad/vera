import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import type { ToWorker } from "../../clients/ui/src/extensions/envelope.ts";
import { DesktopExtensionSystem } from "../../clients/ui/src/extensions/system.ts";
import { desktopExtensions, setDesktopExtensions, subscribeDesktopExtensions } from "../../clients/ui/src/extensions/state.ts";
import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import type { WorkerLink } from "../../clients/ui/src/extensions/runtime.ts";
import { ExtensionService } from "../../clients/desktop/src/extensions/service.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { importThemeFile } from "../../extensions/vscode-theme-import/import-theme.ts";
import { parseInstallReply, parseInstallTask } from "../../clients/desktop/src/extension-install/task-protocol.ts";
import { runInstallTask } from "../../clients/desktop/src/extension-install/run-task.ts";
import { tarGzBytes } from "./extension-fixtures.ts";

const NO_TIMERS = { set: () => 0, clear: () => undefined, now: () => 0 };
const scratch = mkdtempSync(join(process.cwd(), ".extension-theme-replacement-"));

function writeText(path: string, text: string): string {
    writeFileSync(path, text);
    return path;
}

afterEach(() => {
    setDesktopExtensions([]);
    rmSync(scratch, { recursive: true, force: true });
});

test("theme import replaces an active imported extension and silently cancels its runs", async () => {
    const home = join(scratch, "home");
    const extensionId = "imported.pirate-crow";
    const store = new ExtensionStore(home, new ExtensionStateStore(join(home, "machine", "desktop-extensions.json")));
    const themes = new ThemeService(store, themesDirectory(home));
    const service = new ExtensionService(store, themes, async (task) => {
        const parsed = parseInstallTask(structuredClone(task));
        if (parsed === undefined) throw new Error("Install task did not parse.");
        const reply = parseInstallReply(structuredClone(runInstallTask(parsed)));
        if (reply === undefined) throw new Error("Install reply did not parse.");
        return reply;
    });
    const fixturePath = join(scratch, "fixture.tgz");
    const manifest = {
        id: extensionId,
        version: "1.0.0",
        engine: DESKTOP_ENGINE,
        main: "main.js",
        contributes: {
            commands: [{ command: `${extensionId}.run`, title: "Run" }],
            keybindings: [{ command: `${extensionId}.run`, key: "ctrl+alt+f" }],
        },
    };
    await Bun.write(fixturePath, tarGzBytes([
        { name: "vera.desktop.json", data: JSON.stringify(manifest) },
        { name: "main.js", data: "export function activate() {}" },
    ]));
    const preview = await service.preview(fixturePath);
    if (!preview.ok || preview.preview === undefined) throw new Error("Worker fixture did not preview.");
    expect(service.confirm(preview.preview.token).ok).toBe(true);

    const commands = new CommandRegistry();
    const links: { readonly posted: ToWorker[]; readonly receive: (message: unknown) => void; terminated: boolean }[] = [];
    let linkCreated!: () => void;
    const linked = new Promise<void>((resolve) => { linkCreated = resolve; });
    const toasts: string[] = [];
    const system = new DesktopExtensionSystem({
        commands,
        bridge: {
            readDesktopExtensionMain: (id) => service.readMain(id),
            logDesktopExtension: () => undefined,
        },
        platform: "linux",
        createLink: (_id, receive): WorkerLink => {
            const link = { posted: [] as ToWorker[], receive, terminated: false };
            links.push(link);
            linkCreated();
            return { post: (message) => link.posted.push(message), terminate: () => { link.terminated = true; } };
        },
        toast: (text) => toasts.push(text),
        timers: NO_TIMERS,
    });
    const unsubscribe = subscribeDesktopExtensions((replacedId) => {
        system.sync(desktopExtensions() ?? [], replacedId);
    });
    const initial = service.list();
    if (!initial.ok) throw new Error("The installed extension did not list.");
    setDesktopExtensions(initial.extensions);
    expect(commands.execute(`${extensionId}.run`)).toBe(true);
    await linked;
    expect(links).toHaveLength(1);
    expect(commands.execute(`${extensionId}.run`)).toBe(true);
    expect(links[0]!.posted.filter((message) => message.type === "run")).toHaveLength(0);
    links[0]!.receive({ type: "loaded" });
    links[0]!.receive({ type: "context", key: `${extensionId}.busy`, value: true });
    expect(links[0]!.posted.filter((message) => message.type === "run")).toHaveLength(2);

    const themePath = writeText(join(scratch, "theme.json"), JSON.stringify({
        name: "Pirate Crow", type: "dark", colors: { "editor.background": "#10131a" },
    }));
    const converted = importThemeFile(themePath);
    if (!converted.ok) throw new Error(converted.reason);
    expect(themes.install(converted.themes, converted.skipped).ok).toBe(true);
    const refreshed = service.list();
    const replacement = refreshed.ok ? refreshed.extensions.find((entry) => entry.id === extensionId) : undefined;
    expect(replacement).toMatchObject({ id: extensionId, hasCommands: false, hasMain: false });
    expect(replacement?.worker).toBeUndefined();
    expect(replacement?.commands).toEqual([]);
    if (!refreshed.ok) throw new Error("The refreshed extension list failed.");
    setDesktopExtensions(refreshed.extensions);

    expect(links[0]!.terminated).toBe(true);
    expect(commands.list().map((command) => command.id)).not.toContain(`${extensionId}.run`);
    expect(system.handleKey({ key: "f", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, target: null })).toBeUndefined();
    expect(system.context.snapshot().get(`${extensionId}.busy`)).toBeUndefined();
    links[0]!.receive({ type: "failed", call: 1, reason: "late failure" });
    expect(toasts).toEqual([]);
    expect(refreshed.ok && refreshed.themes.map((theme) => theme.slug)).toContain("pirate-crow");
    unsubscribe();
    system.dispose();
});
