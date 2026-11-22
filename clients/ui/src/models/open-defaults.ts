export const OPEN_MODEL_DEFAULTS_EVENT = "vera-open-model-defaults";

export interface OpenModelDefaultsDetail {
    onSubagentsChanged: () => void;
}

export function openModelDefaults(from: Element, onSubagentsChanged: () => void): void {
    from.closest(".session-page")?.dispatchEvent(new CustomEvent<OpenModelDefaultsDetail>(OPEN_MODEL_DEFAULTS_EVENT, {
        detail: { onSubagentsChanged },
    }));
}
