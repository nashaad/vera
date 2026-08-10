import type { VeraExtensionConfig } from "../../src/config.ts";
import { bundledClientExtensionConfigs } from
    "../../src/extensions/bundled-client.ts";
import {
    startClientExtensionRegistry,
    type ClientExtensionAddressingAdapter,
    type ClientExtensionAgentsAdapter,
    type ClientExtensionConsultAdapter,
    type ClientExtensionExperimentalTuiAdapter,
    type ClientExtensionMentionsAdapter,
    type ClientExtensionModelSettingsAdapter,
    type ClientExtensionPickerAdapter,
    type ClientExtensionRegistry,
    type ClientExtensionRegistryFailure,
    type ClientExtensionSidebarAdapter,
    type ClientExtensionThreadAdapter,
    type ClientExtensionTranscriptAdapter,
} from "../../src/extensions/client-registry.ts";
import type { VeraClientTranscriptBlock } from "../../src/sdk/extensions.ts";
import {
    deleteTuiExtensionPreference,
    loadTuiExtensionPreference,
    saveTuiExtensionPreference,
} from "./theme-preference.ts";
import {
    registerExtensionTuiCommands,
    type TuiCommandRegistry,
} from "./commands.ts";
import { tuiChordOwner } from "./keymap.ts";

export interface StartTuiClientExtensionHostOptions {
    readonly extensions: readonly VeraExtensionConfig[];
    readonly currentModelSettings: ClientExtensionModelSettingsAdapter["current"];
    readonly updateModelSettings: ClientExtensionModelSettingsAdapter["update"];
    readonly subscribeModelSettings: ClientExtensionModelSettingsAdapter["subscribe"];
    readonly requestPicker: ClientExtensionPickerAdapter["request"];
    readonly requestConsult: ClientExtensionConsultAdapter["request"];
    readonly openSidebar: ClientExtensionSidebarAdapter["open"];
    readonly appendSidebar: ClientExtensionSidebarAdapter["append"];
    readonly clearSidebar: ClientExtensionSidebarAdapter["clear"];
    readonly closeSidebar: ClientExtensionSidebarAdapter["close"];
    readonly setMentions: ClientExtensionMentionsAdapter["set"];
    readonly setAddressing: ClientExtensionAddressingAdapter["set"];
    readonly agents: ClientExtensionAgentsAdapter;
    readonly experimentalTui: ClientExtensionExperimentalTuiAdapter;
    readonly readThread: ClientExtensionThreadAdapter["read"];
    readonly appendTranscript: (
        block: VeraClientTranscriptBlock,
    ) => void;
    readonly postNotice: (text: string) => void;
    readonly commandRegistry: TuiCommandRegistry;
    readonly signal?: AbortSignal;
    readonly onFailure: (failure: ClientExtensionRegistryFailure) => void;
}

export interface TuiClientExtensionHostController {
    current(): ClientExtensionRegistry | undefined;
    reload(
        start?: (signal: AbortSignal) => Promise<ClientExtensionRegistry>,
    ): Promise<ClientExtensionRegistry | undefined>;
    close(): Promise<void>;
}

/**
 * Owns replaceable client generations without touching the resident host.
 * Reload is deliberately dispose-then-activate: activation APIs reach live
 * client surfaces, so pretending a candidate generation is invisible would
 * make rollback incomplete.
 */
export function createTuiClientExtensionHostController(
    start: (signal: AbortSignal) => Promise<ClientExtensionRegistry>,
    onChange: (registry: ClientExtensionRegistry | undefined) => void,
): TuiClientExtensionHostController {
    let registry: ClientExtensionRegistry | undefined;
    let closed = false;
    let tail = Promise.resolve();
    let activating: AbortController | undefined;

    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = tail.then(operation, operation);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };

    return {
        current: () => registry,
        reload(
            replacementStart = start,
        ): Promise<ClientExtensionRegistry | undefined> {
            return enqueue(async () => {
                if (closed) return undefined;
                const previous = registry;
                registry = undefined;
                if (previous !== undefined) {
                    onChange(undefined);
                }
                await previous?.close();
                if (closed) return undefined;
                const controller = new AbortController();
                activating = controller;
                let replacement: ClientExtensionRegistry;
                try {
                    replacement = await replacementStart(controller.signal);
                } finally {
                    if (activating === controller) {
                        activating = undefined;
                    }
                }
                if (closed) {
                    await replacement.close();
                    return undefined;
                }
                registry = replacement;
                onChange(replacement);
                return replacement;
            });
        },
        close(): Promise<void> {
            closed = true;
            activating?.abort();
            return enqueue(async () => {
                const previous = registry;
                registry = undefined;
                if (previous !== undefined) {
                    onChange(undefined);
                }
                await previous?.close();
            });
        },
    };
}

export function configuredTuiClientExtensions(
    disabledBuiltinExtensions: readonly string[],
    extensions: readonly VeraExtensionConfig[] = [],
): readonly VeraExtensionConfig[] {
    return [
        ...bundledClientExtensionConfigs(disabledBuiltinExtensions),
        ...extensions,
    ];
}

/** Binds portable client-extension APIs to one TUI process generation. */
export async function startTuiClientExtensionHost(
    options: StartTuiClientExtensionHostOptions,
): Promise<ClientExtensionRegistry> {
    const registry = await startClientExtensionRegistry({
        extensions: options.extensions,
        preferences: {
            async get(namespace, key) {
                return loadTuiExtensionPreference(namespace, key);
            },
            async set(namespace, key, value) {
                saveTuiExtensionPreference(namespace, key, value);
            },
            async delete(namespace, key) {
                deleteTuiExtensionPreference(namespace, key);
            },
        },
        modelSettings: {
            current: options.currentModelSettings,
            update: options.updateModelSettings,
            subscribe: options.subscribeModelSettings,
        },
        picker: { request: options.requestPicker },
        consult: { request: options.requestConsult },
        sidebar: {
            open: options.openSidebar,
            append: options.appendSidebar,
            clear: options.clearSidebar,
            close: options.closeSidebar,
        },
        mentions: { set: options.setMentions },
        addressing: { set: options.setAddressing },
        agents: options.agents,
        experimentalTui: options.experimentalTui,
        thread: { read: options.readThread },
        transcript: {
            append(_extensionId, block) {
                options.appendTranscript(block);
            },
        },
        notice: {
            post(_extensionId, text) {
                options.postNotice(text);
            },
        },
        reservedCommandNames:
            options.commandRegistry.registeredCommands().map(({ name }) => name),
        reservedKeybindingKeys: [],
        onFailure: options.onFailure,
        signal: options.signal,
    });
    let disposeCommands: (() => void) | undefined;
    try {
        for (const binding of registry.keybindings()) {
            for (const key of binding.keys) {
                const owner = tuiChordOwner(key);
                if (owner !== undefined && owner.extensionId !== binding.id) {
                    options.postNotice(
                        `${binding.id} cannot use ${key}: Vera already uses it to ${owner.description.toLowerCase()}`,
                    );
                }
            }
        }
        disposeCommands = registerExtensionTuiCommands(
            options.commandRegistry,
            registry.commands(),
            "client",
        );
    } catch (error) {
        try {
            await registry.close();
        } catch (cleanupError) {
            throw new Error(
                `${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`,
            );
        }
        throw error;
    }

    let closing: Promise<void> | undefined;
    return {
        ...registry,
        close(): Promise<void> {
            closing ??= (async () => {
                disposeCommands?.();
                await registry.close();
            })();
            return closing;
        },
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
