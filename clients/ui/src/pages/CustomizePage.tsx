import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon, FolderIcon, RefreshIcon, SearchIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import {
    buildItems,
    cardBadges,
    folderChoices,
    groupByScope,
    KIND_LABELS,
    kindCounts,
    visibleItems,
    type CustomizeItem,
    type KindFilter,
} from "../customize/catalog.ts";
import { CustomizeDetail, KindIcon } from "../customize/CustomizeDetail.tsx";
import { probeTarget } from "../customize/probe.ts";
import { useCatalogProbe } from "../customize/useCatalogProbe.ts";
import type { DesktopBridge, ExtensionFailure } from "../protocol/bridge.ts";
import { folderName } from "../protocol/sessionGroups.ts";
import { useActiveSession } from "../session/activeSession.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { EmptyState, Page } from "./Page.tsx";
import { useRouter } from "./router.tsx";

type FailureState =
    | { readonly phase: "loading" }
    | { readonly phase: "ok"; readonly failures: readonly ExtensionFailure[] }
    | { readonly phase: "failed"; readonly reason: string };

const KIND_PILLS: readonly KindFilter[] = ["all", "skills", "agents", "extensions", "instructions", "memory"];

// Discover has no catalog behind it: the host serves only what is installed, so it shows an unavailable state.
type CustomizeMode = "yours" | "discover";

function desktopBridge(): DesktopBridge | undefined {
    return typeof window === "undefined" ? undefined : window.veraDesktop;
}

function useExtensionFailures(bridge: DesktopBridge | undefined, reload: number): FailureState {
    const [state, setState] = useState<FailureState>({ phase: "loading" });
    useEffect(() => {
        if (bridge === undefined) {
            setState({ phase: "failed", reason: "This window has no host bridge." });
            return undefined;
        }
        let live = true;
        setState({ phase: "loading" });
        bridge.readExtensionFailures().then(
            (result) => {
                if (!live) return;
                setState(result.ok ? { phase: "ok", failures: result.failures } : { phase: "failed", reason: result.reason });
            },
            () => {
                if (live) setState({ phase: "failed", reason: "The extension list did not load." });
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, reload]);
    return state;
}

interface FolderMenuProps {
    readonly folder: string | undefined;
    readonly folders: readonly string[];
    readonly onPick: (folder: string) => void;
}

// The folder button and its menu of folders with sessions; the menu drops down, unlike the composer's chip.
function FolderMenu({ folder, folders, onPick }: FolderMenuProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const placed = usePopoverPlacement(open, root);

    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: MouseEvent): void => {
            if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const choices = folder !== undefined && !folders.includes(folder) ? [folder, ...folders] : folders;
    return (
        <div className="customize-folder" ref={root}>
            <button
                type="button"
                className="ghost-btn"
                aria-haspopup="menu"
                aria-expanded={open}
                title={folder}
                disabled={choices.length === 0}
                onClick={() => setOpen(!open)}
            >
                <FolderIcon />
                {folder === undefined ? "No folder" : folderName(folder)}
                <ChevronDownIcon />
            </button>
            {open ? (
                <div className="folder-menu" role="menu" data-popover="below-start" style={placed}>
                    {choices.map((choice) => (
                        <button
                            key={choice}
                            type="button"
                            role="menuitem"
                            className="folder-item"
                            title={choice}
                            onClick={() => {
                                setOpen(false);
                                onPick(choice);
                            }}
                        >
                            <span className="folder-item-name">{folderName(choice)}</span>
                            <span className="folder-item-path">{choice}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function CustomizeCard({ item, onOpen }: { readonly item: CustomizeItem; readonly onOpen: () => void }) {
    const badges = cardBadges(item);
    const model = item.agent?.defaultModel;
    return (
        <button
            type="button"
            className="customize-card"
            data-kind={item.kind}
            data-name={item.name}
            data-failed={item.failed}
            onClick={onOpen}
        >
            <span className="customize-glyph">
                <KindIcon kind={item.kind} className="customize-glyph-icon" />
            </span>
            <span className="customize-card-body">
                <span className="customize-card-name">{item.name}</span>
                {item.description.length > 0 ? <span className="customize-card-desc">{item.description}</span> : null}
                <span className="customize-card-meta">
                    <span>{KIND_LABELS[item.kind].singular}</span>
                    {model === undefined ? null : <span className="customize-code">{model}</span>}
                    {badges.map((badge) => (
                        <span key={badge.label} className="customize-badge" data-tone={badge.danger ? "danger" : undefined}>
                            {badge.label}
                        </span>
                    ))}
                </span>
            </span>
        </button>
    );
}

export function CustomizePage() {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const active = useActiveSession();
    const bridge = desktopBridge();
    const rows = connection.sessionRows ?? [];
    const folders = folderChoices(rows);

    // Starts at the folder on screen or the newest session's folder; until the user picks, the first listed folder.
    const [chosen, setChosen] = useState<string | undefined>(() => (active === undefined || active.chat ? undefined : active.folder) ?? probeTarget(rows)?.workspace);
    const folder = chosen ?? folders[0];
    const target = probeTarget(rows, folder);

    const [reload, setReload] = useState(0);
    const [kind, setKind] = useState<KindFilter>("all");
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<CustomizeItem | undefined>(undefined);
    const [mode, setMode] = useState<CustomizeMode>("yours");
    const yours = mode === "yours";

    const attached = connection.phase === "attached";
    const probe = useCatalogProbe(bridge, target?.id, attached, reload);
    const failures = useExtensionFailures(bridge, reload);

    const failureList = failures.phase === "ok" ? failures.failures : [];
    const items = probe.phase === "ready" ? buildItems(probe, failureList) : [];
    const counts = kindCounts(items);
    const sections = groupByScope(visibleItems(items, kind, query));
    const folderLabel = folder === undefined ? undefined : folderName(folder);

    function discoverBody() {
        return (
            <EmptyState title="Nothing to browse">
                <span>
                    Vera has no catalog of installable extensions or skills. Install an extension from a folder with{" "}
                    <span className="customize-code">{"/extension install <path>"}</span> in the terminal, then open Yours to see it.
                </span>
                <span className="customize-empty-action">
                    <button type="button" className="ghost-btn" onClick={() => setMode("yours")}>
                        Open Yours
                    </button>
                </span>
            </EmptyState>
        );
    }

    function body() {
        if (!attached) {
            return (
                <EmptyState title="Vera is not connected">
                    Customize reads what a session in this folder loads. Connect to Vera to see it.
                </EmptyState>
            );
        }
        if (target === undefined) {
            return (
                <EmptyState title="No session in this folder">
                    <span>Customize reads what a session in this folder loads. Start one to see it.</span>
                    <span className="customize-empty-action">
                        <button
                            type="button"
                            className="solid-btn"
                            onClick={() => navigate(folder === undefined ? { kind: "home" } : { kind: "home", folder })}
                        >
                            New chat here
                        </button>
                    </span>
                </EmptyState>
            );
        }
        if (probe.phase === "failed") {
            return (
                <>
                    <p className="customize-note" data-tone="danger">{probe.error ?? "Customize could not read this session."}</p>
                    <button type="button" className="ghost-btn" onClick={() => setReload(reload + 1)}>Retry</button>
                </>
            );
        }
        if (probe.phase !== "ready") return <p className="customize-note">Reading…</p>;
        return (
            <>
                <div className="toolbar">
                    {KIND_PILLS.map((pill) => (
                        <button
                            key={pill}
                            type="button"
                            className="filter-pill"
                            aria-pressed={kind === pill}
                            onClick={() => setKind(pill)}
                        >
                            {pill === "all" ? "All" : KIND_LABELS[pill].plural}
                            {pill === "all" ? null : <span className="customize-count">{counts[pill]}</span>}
                        </button>
                    ))}
                </div>
                {sections.length === 0 ? <p className="customize-empty">Nothing here</p> : null}
                {sections.map((section) => (
                    <section key={section.group}>
                        <h2 className="section-title">
                            {section.group} <span className="section-count">{section.items.length}</span>
                        </h2>
                        <ul className="customize-grid">
                            {section.items.map((item) => (
                                <li key={item.key}>
                                    <CustomizeCard item={item} onOpen={() => setPicked(item)} />
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </>
        );
    }

    return (
        <Page
            title="Customize"
            lede={folderLabel === undefined ? "What Vera loads for a session in a folder." : `What Vera loads for ${folderLabel}.`}
            wide
        >
            <div className="toolbar">
                <FolderMenu folder={folder} folders={folders} onPick={setChosen} />
                <div className="customize-seg" role="group" aria-label="Customize view">
                    <button type="button" aria-pressed={yours} onClick={() => setMode("yours")}>
                        Yours
                    </button>
                    <button type="button" aria-pressed={!yours} onClick={() => setMode("discover")}>
                        Discover
                    </button>
                </div>
                {yours ? (
                    <button type="button" className="ghost-btn" onClick={() => setReload(reload + 1)} disabled={target === undefined}>
                        <RefreshIcon />
                        Reload
                    </button>
                ) : null}
                {yours && attached && probe.phase === "ready" ? (
                    <label className="search-field">
                        <SearchIcon />
                        <input
                            type="search"
                            aria-label="Search customizations"
                            placeholder="Search skills, agents, instructions"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                ) : null}
            </div>
            {yours && target !== undefined && attached ? <p className="customize-source">Read through {target.name}</p> : null}
            {yours && probe.phase === "ready" ? probe.warnings.map((warning, index) => (
                <p key={`${index}:${warning}`} className="customize-note">{warning}</p>
            )) : null}
            {yours && failures.phase === "failed" ? (
                <p className="customize-note">Extension failures could not be read: {failures.reason}</p>
            ) : null}
            {yours ? body() : discoverBody()}
            {picked === undefined ? null : <CustomizeDetail item={picked} onClose={() => setPicked(undefined)} />}
        </Page>
    );
}
