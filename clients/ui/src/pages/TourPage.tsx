import { useEffect, useState } from "react";

import { THEME_COMMANDS } from "../commands/theme-commands.ts";
import { CheckIcon, ChevronRightIcon, PlayIcon } from "../components/Icons.tsx";
import { THEME_LABELS, themeFromAttribute } from "./settings/appearance.ts";
import { SettingRow } from "./settings/SettingRow.tsx";
import { workspaceFolders } from "./settings/workspaces.ts";
import { THEME_NAMES, type ThemeName } from "../theme/tokens.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { Page } from "./Page.tsx";
import { useRouter } from "./router.tsx";
import { tourGroups, type TourCard } from "./tour.ts";

// The theme can also change from the View menu, so the select follows the root attribute.
function useActiveTheme(): [ThemeName, (name: ThemeName) => void] {
    const [theme, setTheme] = useState<ThemeName>(() => themeFromAttribute(document.documentElement.getAttribute("data-theme")));
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setTheme(themeFromAttribute(document.documentElement.getAttribute("data-theme")));
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, []);
    return [theme, setTheme];
}

interface TourCardViewProps {
    readonly card: TourCard;
    readonly done: boolean;
    readonly onOpen: (card: TourCard) => void;
}

function TourCardView({ card, done, onOpen }: TourCardViewProps) {
    const Glyph = done ? CheckIcon : PlayIcon;
    return (
        <button
            type="button"
            className="tour-card"
            data-card={card.id}
            disabled={card.action === undefined}
            onClick={() => onOpen(card)}
        >
            <span className="tour-glyph">
                <Glyph className="tour-glyph-icon" />
            </span>
            <span className="tour-card-body">
                <span className="tour-card-name">{card.name}</span>
                <span className="tour-card-desc">{card.desc}</span>
            </span>
            <ChevronRightIcon className="tour-card-chevron" />
        </button>
    );
}

// Every screen, sheet and session state one click away. Nothing is staged: each card opens the real thing.
export function TourPage() {
    const { connection } = useViewEnvironment();
    const router = useRouter();
    const workbench = useWorkbench();
    const [lastClicked, setLastClicked] = useState<string | undefined>(undefined);
    const [theme, setTheme] = useActiveTheme();

    const rows = connection.sessionRows;
    const newestFolder = rows === undefined ? undefined : workspaceFolders(rows)[0];
    const groups = tourGroups(rows, connection.phase === "attached", newestFolder);

    function open(card: TourCard): void {
        if (card.action === undefined) return;
        setLastClicked(card.id);
        if (card.action.kind === "route") router.navigate(card.action.route);
        else workbench.run(card.action.commandId);
    }

    function changeTheme(name: ThemeName): void {
        workbench.run(THEME_COMMANDS[name]);
        setTheme(name);
    }

    return (
        <Page
            title="Tour"
            lede="Every screen, sheet and session state in this window, one click away. Nothing here is staged: each card opens the real thing on the host this window is attached to."
            Icon={PlayIcon}
            wide
            actions={(
                <button type="button" className="ghost-btn" onClick={() => router.navigate({ kind: "coverage" })}>
                    <CheckIcon className="tour-button-icon" />
                    Coverage
                </button>
            )}
        >
            {groups.map((group) => (
                <section key={group.title}>
                    <h2 className="section-title">{group.title}</h2>
                    <div className="tour-grid">
                        {group.cards.map((card) => (
                            <TourCardView key={card.id} card={card} done={card.id === lastClicked} onOpen={open} />
                        ))}
                    </div>
                </section>
            ))}
            <h2 className="section-title">Appearance</h2>
            <SettingRow name="Theme" description="Applies to this window at once. Settings > Appearance has the rest.">
                <select
                    className="tour-select"
                    aria-label="Theme"
                    value={theme}
                    onChange={(event) => changeTheme(event.currentTarget.value as ThemeName)}
                >
                    {THEME_NAMES.map((name) => (
                        <option key={name} value={name}>{THEME_LABELS[name]}</option>
                    ))}
                </select>
            </SettingRow>
        </Page>
    );
}
