import { Fragment, useState } from "react";

import { CodeIcon, EyeIcon, MoreIcon } from "../components/Icons.tsx";
import { KindIcon } from "./KindIcon.tsx";
import { KIND_LABELS } from "../customize/catalog.ts";
import { SOURCE_TEXT_LIMIT } from "../customize/wire.ts";
import { OverlaySheet } from "../overlays/OverlaySheet.tsx";
import { Markdown } from "../session/Markdown.tsx";
import type { DesktopExtensionsState } from "../customize/useDesktopExtensions.ts";
import {
    pluginFacts,
    pluginName,
    pluginOff,
    pluginSheetMeta,
    type PluginItem,
} from "./items.ts";
import { PluginMenu } from "./PluginMenu.tsx";

export interface PluginSheetProps {
    readonly item: PluginItem;
    readonly folderLabel: string | undefined;
    readonly extensions: DesktopExtensionsState;
    readonly onClose: () => void;
    readonly onTryNow: (item: PluginItem) => void;
}

type Tab = "overview" | "files";
type FileView = "rendered" | "source";

export function PluginSheet({ item, folderLabel, extensions, onClose, onTryNow }: PluginSheetProps) {
    const [tab, setTab] = useState<Tab>("overview");
    const [fileView, setFileView] = useState<FileView>("rendered");
    const [menu, setMenu] = useState<{ readonly x: number; readonly y: number } | undefined>(undefined);
    const content = item.source?.content ?? "";
    const path = item.source?.path;
    const files = path === undefined ? 0 : 1;
    const extension = item.extension;
    const isExtension = extension !== undefined;
    const canTry = item.kind === "skills" && !item.failed;

    const foot = isExtension || canTry ? (
        <>
            {extension === undefined ? null : (
                <button
                    type="button"
                    className="plugin-danger"
                    disabled={extensions.busy}
                    data-desktop-extension-remove={extension.id}
                    onClick={() => extensions.remove(extension.id)}
                >
                    Uninstall
                </button>
            )}
            {canTry ? (
                <button type="button" className="plugin-try" data-plugin-try onClick={() => onTryNow(item)}>
                    Try now
                </button>
            ) : null}
        </>
    ) : undefined;

    const head = (
        <div className="plugin-sheet-tools">
            {extension === undefined ? null : (
                <button
                    type="button"
                    role="switch"
                    className="appearance-switch"
                    aria-checked={extension.enabled}
                    aria-label={extension.id}
                    title={extension.enabled ? "Turn off" : "Turn on"}
                    disabled={extensions.busy}
                    data-desktop-extension-switch={extension.id}
                    onClick={() => extensions.toggle(extension.id, !extension.enabled)}
                >
                    <span className="appearance-switch-knob" />
                </button>
            )}
            <button
                type="button"
                className="icon-button plugin-sheet-more"
                aria-label="More actions"
                aria-haspopup="menu"
                data-plugin-menu
                onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: box.right - 8, y: box.bottom + 4 });
                }}
            >
                <MoreIcon />
            </button>
        </div>
    );

    return (
        <OverlaySheet
            title={<>{pluginName(item)} <span className="plugin-sheet-kind">{KIND_LABELS[item.kind].singular}</span></>}
            lead={<span className="plugin-sheet-tile" data-off={pluginOff(item)}><KindIcon kind={item.kind} /></span>}
            onClose={onClose}
            head={head}
            foot={foot}
            className="plugins-sheet"
            name="plugin-detail"
        >
            <p className="plugin-sheet-meta">{pluginSheetMeta(item, folderLabel).join(" · ")}</p>
            <p className="plugin-sheet-description">{item.description}</p>
            {item.kind === "plugins" ? (
                <div className="plugin-overview">
                    <div className="plugin-markdown" data-plugin-contents>
                        <PluginParts title="Skills" names={item.pluginContents?.skills ?? []} />
                        <PluginParts title="Agents" names={item.pluginContents?.agents ?? []} />
                        <p className="plugin-note">
                            Change this plugin with <code>vera plugin disable {item.name}</code>,{" "}
                            <code>vera plugin remove {item.name}</code>, or <code>/plugins</code> in the terminal.
                        </p>
                    </div>
                    <Facts item={item} folderLabel={folderLabel} />
                </div>
            ) : (<>
            <div className="plugin-tabs" role="tablist" aria-label="Plugin details">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "overview"}
                    className="plugin-tab"
                    data-plugin-tab="overview"
                    onClick={() => setTab("overview")}
                >
                    Overview
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "files"}
                    className="plugin-tab"
                    data-plugin-tab="files"
                    onClick={() => setTab("files")}
                >
                    Files · {files}
                </button>
            </div>
            {tab === "overview" ? (
                <div className="plugin-overview">
                    <div className="plugin-markdown">
                        {content.length === 0 ? (
                            <p className="plugin-empty">No file content was read for this item.</p>
                        ) : (
                            <Markdown text={content} />
                        )}
                        {content.length >= SOURCE_TEXT_LIMIT ? (
                            <p className="plugin-note">
                                Shown up to {SOURCE_TEXT_LIMIT.toLocaleString("en-US")} characters. The file holds the rest.
                            </p>
                        ) : null}
                    </div>
                    <Facts item={item} folderLabel={folderLabel} />
                </div>
            ) : (
                <div className="plugin-files">
                    {path === undefined ? (
                        <p className="plugin-empty">No file was read for this item.</p>
                    ) : (
                        <>
                            <div className="plugin-file-head">
                                <code className="plugin-file-path">{path}</code>
                                <span className="plugin-file-toggle" role="group" aria-label="File view">
                                    <button
                                        type="button"
                                        className="plugin-icon-button"
                                        aria-label="Rendered"
                                        aria-pressed={fileView === "rendered"}
                                        data-plugin-file-view="rendered"
                                        onClick={() => setFileView("rendered")}
                                    >
                                        <EyeIcon />
                                    </button>
                                    <button
                                        type="button"
                                        className="plugin-icon-button"
                                        aria-label="Source"
                                        aria-pressed={fileView === "source"}
                                        data-plugin-file-view="source"
                                        onClick={() => setFileView("source")}
                                    >
                                        <CodeIcon />
                                    </button>
                                </span>
                            </div>
                            {fileView === "rendered" ? (
                                content.length === 0 ? (
                                    <p className="plugin-empty">The file is empty.</p>
                                ) : (
                                    <div className="plugin-markdown">
                                        <Markdown text={content} />
                                    </div>
                                )
                            ) : (
                                <SourceView text={content} />
                            )}
                            {content.length >= SOURCE_TEXT_LIMIT ? (
                                <p className="plugin-note">
                                    Shown up to {SOURCE_TEXT_LIMIT.toLocaleString("en-US")} characters. The file holds the rest.
                                </p>
                            ) : null}
                        </>
                    )}
                </div>
            )}
            </>)}
            {menu === undefined ? null : <PluginMenu item={item} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} />}
        </OverlaySheet>
    );
}

function PluginParts({ title, names }: { readonly title: string; readonly names: readonly string[] }) {
    return (
        <section>
            <h3>{title}</h3>
            {names.length === 0 ? <p className="plugin-empty">None loaded.</p> : (
                <ul>{names.map((name) => <li key={name}>{name}</li>)}</ul>
            )}
        </section>
    );
}

function Facts({ item, folderLabel }: { readonly item: PluginItem; readonly folderLabel: string | undefined }) {
    return (
        <dl className="plugin-facts">
            {pluginFacts(item, folderLabel).map((fact) => (
                <Fragment key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd className={fact.code ? "plugin-code" : undefined}>{fact.value}</dd>
                </Fragment>
            ))}
        </dl>
    );
}

function SourceView({ text }: { readonly text: string }) {
    const lines = text.split("\n");
    return (
        <div className="plugin-source" role="region" aria-label="File source">
            {lines.map((line, index) => (
                <div key={index} className="plugin-source-line">
                    <span className="plugin-line-number">{index + 1}</span>
                    <span className="plugin-line-text">{line.length === 0 ? " " : line}</span>
                </div>
            ))}
        </div>
    );
}
