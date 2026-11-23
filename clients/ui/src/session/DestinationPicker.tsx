import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { GitBranch } from "../../../shared/git-wire.ts";
import { ArrowRightIcon, BranchIcon, CheckIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { useMenuDismiss } from "../composer/useMenuDismiss.ts";

interface DestinationPickerProps {
    readonly branch: string | null;
    readonly destination: string | null;
    readonly branches: readonly GitBranch[];
    readonly partial: boolean;
    readonly onSelect: (branch: string) => void;
}

// The current branch and the branch it is compared with. The picker lists local
// and remote branches and marks the chosen one.
export function DestinationPicker({ branch, destination, branches, partial, onSelect }: DestinationPickerProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [focus, setFocus] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root, query);

    const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return branches.filter((entry) => entry.name.toLowerCase().includes(needle));
    }, [branches, query]);
    const current = Math.min(focus, Math.max(0, rows.length - 1));

    const pick = (name: string): void => {
        setOpen(false);
        onSelect(name);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            trigger.current?.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (rows.length > 0) setFocus((current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        } else if (event.key === "Enter") {
            event.preventDefault();
            const row = rows[current];
            if (row !== undefined) pick(row.name);
        }
    };

    return (
        <div className="changes-destination" ref={root}>
            <button
                ref={trigger}
                type="button"
                className="changes-pill changes-destination-pill"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label="Compare with a branch"
                title="Compare with a branch"
                onClick={() => {
                    setQuery("");
                    setFocus(0);
                    setOpen(!open);
                }}
            >
                <BranchIcon />
                <span className="changes-pill-name">{branch ?? "HEAD"}</span>
                <ArrowRightIcon />
                <span className="changes-pill-name">{destination ?? "Choose destination"}</span>
            </button>
            {open ? (
                <div className="changes-destination-menu menu" role="listbox" aria-label="Destination branch" data-popover="below-end" style={placed} onKeyDown={onKeyDown}>
                    <label className="model-search">
                        <input
                            autoFocus
                            placeholder="Search destination branches"
                            aria-label="Search destination branches"
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setFocus(0);
                            }}
                        />
                    </label>
                    <div className="changes-branch-list">
                        {rows.length === 0 ? <p className="changes-branch-note">No branches match.</p> : <>
                            <p className="changes-branch-heading">Branches</p>
                            {rows.map((row) => (
                                <button
                                    key={row.name}
                                    type="button"
                                    role="option"
                                    aria-selected={row.name === destination}
                                    className="changes-branch-row menu-row"
                                    data-on={row.name === destination}
                                    data-remote={row.remote}
                                    onClick={() => pick(row.name)}
                                >
                                    <BranchIcon />
                                    <span className="changes-branch-name">{row.name}</span>
                                    {row.name === destination ? <CheckIcon /> : null}
                                </button>
                            ))}
                        </>}
                        {partial ? <p className="changes-branch-note">Only the most recent branches are shown.</p> : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
