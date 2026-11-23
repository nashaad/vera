import { XIcon } from "../components/Icons.tsx";
import { fileTabLabels, type FileTab } from "./file-tabs.ts";

interface FileTabsBarProps {
    readonly tabs: readonly FileTab[];
    readonly activePath: string | null;
    readonly onActivate: (path: string) => void;
    readonly onKeep: (path: string) => void;
    readonly onClose: (path: string) => void;
}

export function FileTabsBar({ tabs, activePath, onActivate, onKeep, onClose }: FileTabsBarProps) {
    const labels = fileTabLabels(tabs.map((tab) => tab.path));
    return (
        <div className="file-tabs" role="tablist" aria-label="Open files">
            {tabs.map((tab, index) => (
                <div
                    key={tab.path}
                    role="tab"
                    tabIndex={tab.path === activePath ? 0 : -1}
                    aria-selected={tab.path === activePath}
                    className={`file-tab${tab.preview ? " file-tab--preview" : ""}`}
                    title={tab.path}
                    onClick={() => onActivate(tab.path)}
                    onDoubleClick={() => onKeep(tab.path)}
                    onAuxClick={(event) => {
                        if (event.button === 1) {
                            event.preventDefault();
                            onClose(tab.path);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onActivate(tab.path);
                        }
                    }}
                >
                    <span className="file-tab-label">{labels[index]?.label}</span>
                    <button
                        type="button"
                        className="icon-button file-tab-close"
                        aria-label={`Close ${labels[index]?.label ?? tab.path}`}
                        title="Close"
                        onClick={(event) => {
                            event.stopPropagation();
                            onClose(tab.path);
                        }}
                    ><XIcon /></button>
                </div>
            ))}
        </div>
    );
}
