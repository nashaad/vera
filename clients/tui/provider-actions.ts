import { localRuntimeActions } from "./local-runtime-status.ts";
import type { TuiLocalRuntimeAction, TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

const RUNTIME_ACTIONS: Readonly<Record<string, TuiLocalRuntimeAction>> = {
    runtime_start: "start",
    runtime_stop: "stop",
    runtime_restart: "restart",
    runtime_switch: "switch",
    runtime_logs: "logs",
};

export function providerActions(
    parent: TuiSettingsPickerState,
    provider: TuiSettingsPickerOption,
): TuiSettingsPickerState {
    const editable = provider.declared === true || provider.endpointEditable === true;
    const options: TuiSettingsPickerOption[] = [];
    // A provider that has never answered is here to be connected. Without this
    // the only way through is the endpoint form, which asks for a URL the user
    // has no reason to change.
    if (provider.answerState !== "connected") {
        options.push({
            value: "connect",
            label: "Connect",
            description: "Set this provider up and read its catalog",
        });
    }
    options.push({
        value: editable ? "edit" : "reconnect",
        label: editable ? "Edit" : "Reconnect",
        description: editable ? "Change the endpoint or credentials" : "Sign in again",
    });
    // A provider Vera runs itself is also a process to start, stop and point
    // elsewhere. Those belong here rather than on keys of their own.
    if (provider.localRuntime === true) {
        options.push(...localRuntimeActions(parent.localRuntime));
    }
    if (provider.refreshable === true) {
        options.push({ value: "refresh", label: "Refresh", description: "Read this provider's model catalog" });
    }
    return {
        kind: "provider_actions",
        title: provider.label,
        allOptions: options,
        options,
        query: "",
        selectedIndex: 0,
        parent,
    };
}

export function providerActionTransition(state: TuiSettingsPickerState): TuiSettingsPickerTransition {
    const parent = state.parent;
    const provider = parent?.options[parent.selectedIndex];
    const action = state.options[state.selectedIndex]?.value;
    if (parent?.kind !== "provider" || provider === undefined) {
        return { state, handled: true };
    }
    if (action === "connect") {
        return { state: parent, handled: true, selection: { kind: "provider", providerId: provider.value } };
    }
    if (action === "edit") {
        return provider.declared === true
            ? { state: parent, handled: true, editProvider: provider.value }
            : { state: parent, handled: true, editEndpoint: provider.value };
    }
    if (action === "refresh") {
        return { state: parent, handled: true, refreshCatalog: provider.value };
    }
    const runtime = action === undefined ? undefined : RUNTIME_ACTIONS[action];
    if (runtime !== undefined) {
        return {
            state: parent,
            handled: true,
            runtimeAction: { provider: provider.value, action: runtime },
        };
    }
    if (action === "reconnect") {
        return { state: parent, handled: true, selection: { kind: "provider", providerId: provider.value } };
    }
    return { state, handled: true };
}
