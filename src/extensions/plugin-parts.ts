import { lstatSync, realpathSync } from "node:fs";

import { pluginDirectoryIn } from "../profile-paths.ts";
import { emptyPluginSnapshot, readPluginCatalog, type PluginHostExtensionPart, type PluginSnapshot } from "../plugins/catalog.ts";
import { readPluginPartFolders } from "../plugins/manifest.ts";
import { extensionServesHost, loadExtensionManifest } from "./manifest.ts";
import { withinExtensionDirectory } from "./plugin-paths.ts";

export function readPluginExtensionSnapshot(veraHome: string): PluginSnapshot {
    const catalog = readPluginCatalog({ veraHome });
    const hostExtensions: PluginHostExtensionPart[] = [];
    for (const record of catalog.plugins) {
        if (!record.enabled || record.components.host_extension === null) continue;
        try {
            const packagePath = pluginDirectoryIn(veraHome, record.name);
            const details = lstatSync(packagePath, { bigint: true });
            if (!details.isDirectory()) continue;
            const packageRoot = realpathSync(packagePath);
            const folders = readPluginPartFolders(packageRoot);
            if (!lstatSync(folders.extension).isDirectory()) continue;
            const extension = loadExtensionManifest(folders.extension);
            if (!withinExtensionDirectory(packageRoot, extension.directory)
                || extension.manifest.id !== record.components.host_extension) continue;
            hostExtensions.push({
                plugin: record.name,
                id: extension.manifest.id,
                directory: extension.directory,
                package_identity: {
                    directory: packageRoot,
                    dev: details.dev.toString(),
                    ino: details.ino.toString(),
                },
                enabled: record.enabled,
                serves_host: extensionServesHost(extension.manifest),
                provides_model_middleware: extension.manifest.capabilities.includes("hooks.model_middleware"),
            });
        } catch {
            continue;
        }
    }
    return {
        ...emptyPluginSnapshot(),
        vera_home: veraHome,
        plugins: catalog.plugins.filter((record) => record.enabled),
        host_extensions: hostExtensions,
        host_extension_owners: catalog.plugins.flatMap((record) =>
            record.components.host_extension === null
                ? []
                : [{ plugin: record.name, id: record.components.host_extension }]
        ),
        warnings: catalog.warnings,
    };
}
