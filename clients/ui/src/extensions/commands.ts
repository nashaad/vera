import type { CommandRegistry } from "../commands/registry.ts";
import type { DesktopCommandEntry, DesktopExtensionEntry } from "../protocol/extensions.ts";

export function extensionCommandTitle(command: DesktopCommandEntry): string {
    return command.category === undefined ? command.title : `${command.category}: ${command.title}`;
}

// Registers the commands of every enabled extension, so the palette lists them; the returned function removes them.
// An id the registry already holds is left alone.
export function registerExtensionCommands(
    registry: CommandRegistry,
    entries: readonly DesktopExtensionEntry[],
    run: (command: string) => void,
): () => void {
    const disposers: (() => void)[] = [];
    for (const entry of entries) {
        if (!entry.enabled) continue;
        for (const command of entry.commands) {
            if (registry.has(command.id)) continue;
            disposers.push(registry.register({ id: command.id, title: extensionCommandTitle(command), run: () => run(command.id) }));
        }
    }
    return () => disposers.forEach((dispose) => dispose());
}
