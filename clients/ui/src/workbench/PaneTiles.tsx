import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { canOpenTab } from "../layout/resolve.ts";
import { ContainerIcon } from "./ContainerIcon.tsx";
import { useWorkbench } from "./context.tsx";
import { containerShortcutKeys } from "./hints.ts";

// What the right pane shows while it has no tab: one tile per kind of tab. A tile opens a new tab.
export function PaneTiles() {
    const { layout, run } = useWorkbench();
    const platform = window.veraDesktop?.platform ?? "";
    return (
        <div className="pane-tiles" data-pane-tiles>
            <div className="pane-tiles-grid">
                {layout.locations.rightPane.containers.map((container) => {
                    const keys = containerShortcutKeys(container.id, platform);
                    return (
                        <button
                            key={container.id}
                            type="button"
                            className="pane-tile"
                            data-pane-tile={container.id}
                            disabled={!canOpenTab(layout, container.id)}
                            onClick={() => run(LAYOUT_COMMANDS.tabOpen, { container: container.id })}
                        >
                            <ContainerIcon name={container.icon} className="pane-tile-icon" />
                            <span className="pane-tile-title">{container.title}</span>
                            {keys.length === 0 ? null : (
                                <span className="pane-tile-keys">
                                    {keys.map((key) => <kbd key={key} className="kbd">{key}</kbd>)}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
