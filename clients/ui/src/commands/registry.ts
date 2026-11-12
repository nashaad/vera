export interface Command {
    readonly id: string;
    readonly title: string;
    // Set on commands that do nothing without arguments, so the palette leaves them out.
    readonly needsArgs?: true;
    run(args?: unknown): void;
}

// Every layout action is a command, so menus, shortcuts and a later palette share one entry.
export class CommandRegistry {
    private readonly commands = new Map<string, Command>();

    register(command: Command): () => void {
        if (this.commands.has(command.id)) throw new Error(`Command ${command.id} is already registered.`);
        this.commands.set(command.id, command);
        return () => {
            if (this.commands.get(command.id) === command) this.commands.delete(command.id);
        };
    }

    has(id: string): boolean {
        return this.commands.has(id);
    }

    list(): readonly Command[] {
        return [...this.commands.values()];
    }

    // False when no such command exists, so a caller can tell a stale menu from a no-op.
    execute(id: string, args?: unknown): boolean {
        const command = this.commands.get(id);
        if (command === undefined) return false;
        command.run(args);
        return true;
    }
}
