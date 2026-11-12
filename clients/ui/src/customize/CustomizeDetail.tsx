import { Fragment, useState, type ReactElement } from "react";

import {
    AgentIcon,
    BoltIcon,
    ClockIcon,
    FileIcon,
    LayersIcon,
    type IconProps,
} from "../components/Icons.tsx";
import { OverlaySheet } from "../overlays/OverlaySheet.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { dirname, itemFacts, type CustomizeItem, type CustomizeKind } from "./catalog.ts";
import { SOURCE_TEXT_LIMIT } from "./wire.ts";

type KindIconComponent = (props: IconProps) => ReactElement;

const KIND_ICONS: Readonly<Record<CustomizeKind, KindIconComponent>> = {
    skills: BoltIcon,
    agents: AgentIcon,
    extensions: LayersIcon,
    instructions: FileIcon,
    memory: ClockIcon,
};

export function KindIcon({ kind, className }: IconProps & { readonly kind: CustomizeKind }) {
    const Icon = KIND_ICONS[kind];
    return <Icon className={className} />;
}

export interface CustomizeDetailProps {
    readonly item: CustomizeItem;
    readonly onClose: () => void;
}

function desktopBridge(): DesktopBridge | undefined {
    return typeof window === "undefined" ? undefined : window.veraDesktop;
}

// Opens the folder that holds the item's file; the file itself is never run or edited here.
export function CustomizeDetail({ item, onClose }: CustomizeDetailProps) {
    const bridge = desktopBridge();
    const [revealFailed, setRevealFailed] = useState(false);
    const path = item.source?.path;
    const revealLabel = bridge?.platform === "darwin" ? "Show in Finder" : "Open folder";
    const content = item.source?.content ?? "";
    const facts = itemFacts(item);

    async function reveal(): Promise<void> {
        if (bridge === undefined || path === undefined) return;
        const opened = await bridge.revealFolder(dirname(path)).catch(() => false);
        setRevealFailed(!opened);
    }

    // The agent catalog carries no file path, so an agent with no matching source has nothing to reveal.
    const foot = bridge === undefined || path === undefined ? undefined : (
        <button type="button" className="ghost-btn" onClick={() => void reveal()}>
            {revealLabel}
        </button>
    );

    return (
        <OverlaySheet title={item.name} Icon={KIND_ICONS[item.kind]} onClose={onClose} foot={foot} wide name="customize-detail">
            <dl className="customize-facts">
                {facts.map((fact) => (
                    <Fragment key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd className={fact.code ? "customize-code" : undefined}>{fact.value}</dd>
                    </Fragment>
                ))}
            </dl>
            {content.length > 0 ? <pre className="customize-content">{content}</pre> : null}
            {content.length >= SOURCE_TEXT_LIMIT ? (
                <p className="customize-note">Shown up to {SOURCE_TEXT_LIMIT.toLocaleString("en-US")} characters. The file holds the rest.</p>
            ) : null}
            {revealFailed ? <p className="customize-note" data-tone="danger">The folder could not be opened.</p> : null}
        </OverlaySheet>
    );
}
