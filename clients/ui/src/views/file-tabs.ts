export const FILE_TAB_LIMIT = 12;

export type FileTabMode = "source" | "preview";

export interface FileTab {
    readonly path: string;
    readonly preview: boolean;
    readonly mode: FileTabMode;
    readonly lastUsed: number;
}

export interface FileTabsState {
    readonly tabs: readonly FileTab[];
    readonly activePath: string | null;
    readonly clock: number;
}

export interface OpenFileTabOptions {
    readonly preview?: boolean;
    readonly keep?: boolean;
}

export interface FileTabLabel {
    readonly path: string;
    readonly label: string;
}

export type FileTreePosition = "left" | "right";
export type FileTabSize = 2 | 4 | 8;

export interface FileMenuSettings {
    readonly previewTabs: boolean;
    readonly wordWrap: boolean;
    readonly treePosition: FileTreePosition;
    readonly scrollPastEnd: boolean;
    readonly tabSize: FileTabSize;
}

export const DEFAULT_FILE_MENU_SETTINGS: FileMenuSettings = {
    previewTabs: true,
    wordWrap: true,
    treePosition: "right",
    scrollPastEnd: false,
    tabSize: 4,
};

export function emptyFileTabs(): FileTabsState {
    return { tabs: [], activePath: null, clock: 0 };
}

export function openFileTab(
    state: FileTabsState,
    path: string,
    options: OpenFileTabOptions = {},
): FileTabsState {
    const preview = options.keep === true ? false : options.preview === true;
    const clock = state.clock + 1;
    const existing = state.tabs.find((tab) => tab.path === path);
    let tabs = state.tabs.filter((tab) => !(preview && !existing && tab.preview));

    if (existing) {
        tabs = tabs.map((tab) => tab.path === path
            ? { ...tab, preview: tab.preview && preview, lastUsed: clock }
            : tab);
    } else {
        tabs = [...tabs, { path, preview, mode: "source", lastUsed: clock }];
    }

    while (tabs.length > FILE_TAB_LIMIT) {
        const candidates = tabs.filter((tab) => !tab.preview && tab.path !== path);
        const victim = [...candidates].sort((left, right) => left.lastUsed - right.lastUsed)[0]
            ?? [...tabs].filter((tab) => tab.path !== path).sort((left, right) => left.lastUsed - right.lastUsed)[0];
        if (!victim) break;
        tabs = tabs.filter((tab) => tab.path !== victim.path);
    }

    return { tabs, activePath: path, clock };
}

export function activateFileTab(state: FileTabsState, path: string): FileTabsState {
    if (!state.tabs.some((tab) => tab.path === path)) return state;
    const clock = state.clock + 1;
    return {
        ...state,
        tabs: state.tabs.map((tab) => tab.path === path ? { ...tab, lastUsed: clock } : tab),
        activePath: path,
        clock,
    };
}

export function setFileTabMode(state: FileTabsState, path: string, mode: FileTabMode): FileTabsState {
    const tab = state.tabs.find((entry) => entry.path === path);
    if (!tab || tab.mode === mode) return state;
    return { ...state, tabs: state.tabs.map((entry) => entry.path === path ? { ...entry, mode } : entry) };
}

export function closeFileTab(state: FileTabsState, path: string): FileTabsState {
    const tabs = state.tabs.filter((tab) => tab.path !== path);
    if (tabs.length === state.tabs.length) return state;
    const activePath = state.activePath === path
        ? [...tabs].sort((left, right) => right.lastUsed - left.lastUsed)[0]?.path ?? null
        : state.activePath;
    return { ...state, tabs, activePath };
}

export function closeAllFileTabs(state: FileTabsState): FileTabsState {
    return { ...state, tabs: [], activePath: null };
}

export function fileTabLabels(paths: readonly string[]): readonly FileTabLabel[] {
    const parts = paths.map((path) => path.replaceAll("\\", "/").split("/").filter(Boolean));
    return paths.map((path, index) => {
        const segments = parts[index] ?? [];
        const depth = Math.max(1, segments.length);
        let label = segments.slice(-1).join("/") || path;
        const basenameCollides = paths.some((other, otherIndex) => otherIndex !== index
            && parts[otherIndex]?.at(-1) === segments.at(-1));
        if (basenameCollides) {
            for (let suffix = 2; suffix <= depth; suffix += 1) {
                if (paths.every((other, otherIndex) => otherIndex === index
                    || parts[otherIndex]?.slice(-suffix).join("/") !== segments.slice(-suffix).join("/"))) {
                    label = segments.slice(-suffix).join("/");
                    break;
                }
                if (suffix === depth) label = segments.join("/") || path;
            }
        }
        return { path, label };
    });
}

export function updateFileMenuSettings(
    settings: FileMenuSettings,
    patch: Partial<FileMenuSettings>,
): FileMenuSettings {
    return { ...settings, ...patch };
}
