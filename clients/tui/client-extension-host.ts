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
    readonly reservedCommandNames: readonly string[];
    readonly onFailure: (failure: ClientExtensionRegistryFailure) => void;
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
    return startClientExtensionRegistry({
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
        reservedCommandNames: options.reservedCommandNames,
        reservedKeybindingKeys: [],
        onFailure: options.onFailure,
    });
}
