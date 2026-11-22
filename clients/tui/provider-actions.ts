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
    const connected = provider.answerState === "connected";
    if (!connected) {
        options.push({
            value: "connect",
            label: "Connect",
            description: "Set this provider up and read its catalog",
        });
    }
    // Connect and Reconnect start the same sign-in, so only one is offered.
    if (editable) {
        options.push({ value: "edit", label: "Edit", description: "Change the endpoint or credentials" });
    } else if (connected) {
        options.push({ value: "reconnect", label: "Reconnect", description: "Sign in again" });
    }
    if (provider.connected === true) {
        options.push(provider.enabled === false
            ? { value: "turn_on", label: "Turn on", description: "Use it again and read its models" }
            : { value: "turn_off", label: "Turn off", description: "Stop new use and keep the setup; running sessions finish" });
    }
    // A provider Vera runs itself is also a process to start, stop and point
    // elsewhere. Those belong here rather than on keys of their own.
    if (provider.localRuntime === true) {
        options.push(...localRuntimeActions(parent.localRuntime));
    }
    if (provider.refreshable === true && provider.enabled !== false) {
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
    if (action === "turn_off" || action === "turn_on") {
        return { state: parent, handled: true, toggleProviderEnabled: {
            provider: provider.value, enabled: action === "turn_on",
        } };
    }
    if (action === "reconnect") {
        return { state: parent, handled: true, selection: { kind: "provider", providerId: provider.value } };
    }
    return { state, handled: true };
}
