import { useState } from "react";

import { filterShortcutGroups, shortcutGroups, type ShortcutRow } from "../../commands/keys.ts";
import { SearchIcon } from "../../components/Icons.tsx";

function Chords({ row }: { readonly row: ShortcutRow }) {
    return (
        <span className="keyboard-chords">
            {row.chords.map((chord, index) => (
                <span key={index} className="keyboard-chord">
                    {index > 0 ? <span className="keyboard-or">or</span> : null}
                    {chord.map((key, keyIndex) => (
                        <kbd key={keyIndex} className="keyboard-cap">{key}</kbd>
                    ))}
                </span>
            ))}
        </span>
    );
}

export function KeyboardSection() {
    const [query, setQuery] = useState("");
    const platform = window.veraDesktop?.platform ?? "";
    const groups = filterShortcutGroups(shortcutGroups(platform), query);

    return (
        <>
            <h1>Keyboard</h1>
            <label className="keyboard-search">
                <SearchIcon className="keyboard-search-icon" />
                <input
                    type="search"
                    placeholder="Search shortcuts"
                    aria-label="Search shortcuts"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </label>
            {groups.length === 0 ? <p className="settings-muted">No shortcuts match.</p> : null}
            {groups.map((group) => (
                <section key={group.title}>
                    <h2 className="settings-sec">{group.title}</h2>
                    <ul className="keyboard-list">
                        {group.rows.map((row, index) => (
                            <li key={index} className="keyboard-row">
                                <span className="keyboard-label">{row.label}</span>
                                <Chords row={row} />
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
            <p className="settings-note">Shortcuts cannot be changed yet.</p>
        </>
    );
}
