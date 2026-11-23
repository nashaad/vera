import {
    renderPluginInstallPreview,
    renderPluginInstallResult,
    renderPluginList,
    renderPluginMutation,
    renderPluginRemoval,
    renderPluginShow,
    type PluginManagerCommand,
} from "../../../src/plugins/command.ts";
import {
    pluginManager,
    type PluginManagerOperations,
} from "../../../src/plugins/manager.ts";
import { migratePlugins, renderPluginMigration } from "../../../src/plugins/migrate.ts";

export type PluginCommandOutcome =
    | { readonly surface: "dialog"; readonly text: string }
    | { readonly surface: "notice"; readonly text: string };

// What /plugin does after the transcript has already taken the slash line.
export function runPluginCommand(
    command: PluginManagerCommand,
    operations: PluginManagerOperations = pluginManager,
): PluginCommandOutcome {
    switch (command.operation) {
        case "migrate":
            return { surface: "dialog", text: renderPluginMigration(migratePlugins()) };
        case "list":
            return { surface: "dialog", text: renderPluginList(operations.list()) };
        case "show":
            return {
                surface: "dialog",
                text: renderPluginShow(operations.show(command.name)),
            };
        case "install": {
            const result = operations.install({
                source: command.source,
                dry_run: command.dry_run,
            });
            return {
                surface: "dialog",
                text: command.dry_run
                    ? renderPluginInstallPreview(result.preview)
                    : renderPluginInstallResult(result.preview, result.noop),
            };
        }
        case "remove":
            return {
                surface: "notice",
                text: renderPluginRemoval(
                    operations.remove(command.name, { purge: command.purge }),
                ).trimEnd(),
            };
        case "enable":
        case "disable":
            return {
                surface: "notice",
                text: renderPluginMutation(
                    command.operation,
                    operations.setEnabled(
                        command.name,
                        command.operation === "enable",
                    ),
                ).trimEnd(),
            };
    }
}
