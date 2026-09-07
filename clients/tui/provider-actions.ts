import type { TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

export function providerActions(
    parent: TuiSettingsPickerState,
    provider: TuiSettingsPickerOption,
): TuiSettingsPickerState {
    const editable = provider.declared === true || provider.endpointEditable === true;
    const options: TuiSettingsPickerOption[] = [{
        value: editable ? "edit" : "reconnect",
        label: editable ? "Edit" : "Reconnect",
        description: editable ? "Change the endpoint or credentials" : "Sign in again",
    }];
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
    if (action === "edit") {
        return provider.declared === true
            ? { state: parent, handled: true, editProvider: provider.value }
            : { state: parent, handled: true, editEndpoint: provider.value };
    }
    if (action === "refresh") {
        return { state: parent, handled: true, refreshCatalog: provider.value };
    }
    if (action === "reconnect") {
        return { state: parent, handled: true, selection: { kind: "provider", providerId: provider.value } };
    }
    return { state, handled: true };
}
