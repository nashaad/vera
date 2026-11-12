import { Fragment, useMemo, useState } from "react";

import { filterShortcutGroups, shortcutGroups } from "../commands/keys.ts";
import { KeyIcon } from "../components/Icons.tsx";
import { OverlaySheet } from "./OverlaySheet.tsx";

export function ShortcutsSheet({ onClose }: { readonly onClose: () => void }) {
    const [query, setQuery] = useState("");
    const platform = window.veraDesktop?.platform ?? "";
    const groups = useMemo(() => shortcutGroups(platform), [platform]);
    const shown = useMemo(() => filterShortcutGroups(groups, query), [groups, query]);

    return (
        <OverlaySheet title="Keyboard Shortcuts" Icon={KeyIcon} onClose={onClose} wide name="shortcuts">
            <input
                type="search"
                className="shortcuts-search"
                aria-label="Filter shortcuts"
                placeholder="Filter shortcuts"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
            />
            {shown.length === 0 ? <div className="palette-empty">No shortcuts match</div> : null}
            <div className="shortcuts-groups">
                {shown.map((group) => (
                    <section key={group.title} className="shortcuts-group">
                        <h3 className="shortcuts-group-title">{group.title}</h3>
                        {group.rows.map((row) => (
                            <div key={row.label} className="shortcuts-row">
                                <span className="shortcuts-label">{row.label}</span>
                                <span className="shortcuts-chords">
                                    {row.chords.map((chord, chordIndex) => (
                                        <Fragment key={chordIndex}>
                                            {chordIndex === 0 ? null : <span className="shortcuts-or">or</span>}
                                            {chord.map((cap, capIndex) => <kbd className="kbd" key={capIndex}>{cap}</kbd>)}
                                        </Fragment>
                                    ))}
                                </span>
                            </div>
                        ))}
                    </section>
                ))}
            </div>
        </OverlaySheet>
    );
}
