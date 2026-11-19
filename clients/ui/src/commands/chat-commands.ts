import type { CommandRegistry } from "./registry.ts";

export const CHAT_COMMANDS = {
    help: "chat.help",
} as const;

export interface ChatCommandTarget {
    // Starts a new Help chat in a Chat tab.
    readonly help: () => void;
}

export function registerChatCommands(registry: CommandRegistry, target: ChatCommandTarget): () => void {
    return registry.register({ id: CHAT_COMMANDS.help, title: "New Help Chat", run: () => target.help() });
}
