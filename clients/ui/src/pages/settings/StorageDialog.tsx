import { useEffect, useRef, useState } from "react";

import { LayersIcon } from "../../components/Icons.tsx";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import type {
    StorageArea,
    StorageCleanupArea,
    StorageMeasurement,
    StorageMeasured,
} from "../../protocol/storage.ts";
import { OverlaySheet } from "../../overlays/OverlaySheet.tsx";
import { checkedLabel, OLD_SCRATCH_ROW, STORAGE_AREA_ROWS, storageSize } from "./storage.ts";
import { FreeUpSpaceDialog } from "./FreeUpSpaceDialog.tsx";

export interface StorageBodyProps {
    readonly measurement: StorageMeasurement | undefined;
    readonly measuring: boolean;
    readonly failure: string | undefined;
    readonly onRefresh: () => void;
    readonly onOpenFolder: () => void;
    readonly onFree: (area: StorageCleanupArea) => void;
}

export type StorageView =
    | { readonly kind: "ready"; readonly measurement: StorageMeasurement }
    | { readonly kind: "failed"; readonly reason: string };

// Refresh passes true so the host measures the home again instead of answering from its last scan.
export async function loadStorage(
    measure: (refresh: boolean) => Promise<StorageMeasured>,
    refresh: boolean,
): Promise<StorageView> {
    const result = await measure(refresh);
    return result.ok
        ? { kind: "ready", measurement: result.measurement }
        : { kind: "failed", reason: result.reason };
}

interface CategoryPart {
    readonly bytes: number;
    readonly summary: string;
    readonly largest: readonly { readonly name: string; readonly bytes: number }[];
}

function partOf(measurement: StorageMeasurement, area: StorageArea): CategoryPart | undefined {
    return measurement.categories.find((category) => category.category === area);
}

function LargestItems({ part }: { readonly part: CategoryPart | undefined }) {
    if (part === undefined || part.largest.length === 0) {
        return <p className="storage-details-empty">Nothing large to list here.</p>;
    }
    return (
        <ul className="storage-largest">
            {part.largest.map((item) => (
                <li key={`${item.name}:${item.bytes}`}>
                    <span className="storage-largest-name">{item.name}</span>
                    <span className="storage-largest-size">{storageSize(item.bytes)}</span>
                </li>
            ))}
        </ul>
    );
}

function CategoryRow({
    label,
    color,
    part,
    onFree,
}: {
    readonly label: string;
    readonly color: string;
    readonly part: CategoryPart | undefined;
    readonly onFree?: () => void;
}) {
    if (part === undefined) return null;
    return (
        <div className="storage-row">
            <div className="storage-row-main">
                <span className="storage-dot" style={{ background: color }} aria-hidden="true" />
                <div className="storage-row-text">
                    <div className="storage-row-name">{label}</div>
                    <div className="storage-row-summary">{part.summary}</div>
                </div>
                <span className="storage-row-size">{storageSize(part.bytes)}</span>
                {onFree === undefined ? null : (
                    <button type="button" className="ghost-btn" onClick={onFree}>
                        Free up space…
                    </button>
                )}
            </div>
            <details className="storage-details">
                <summary>Details</summary>
                <LargestItems part={part} />
            </details>
        </div>
    );
}

export function StorageBody({ measurement, measuring, failure, onRefresh, onOpenFolder, onFree }: StorageBodyProps) {
    const rows = measurement === undefined ? [] : STORAGE_AREA_ROWS.flatMap((row) => {
        const part = partOf(measurement, row.area);
        return part === undefined ? [] : [{ ...row, part }];
    });
    const total = measurement?.total_bytes ?? 0;
    return (
        <>
            <p className="storage-lede">Space Vera uses on this computer.</p>
            {failure === undefined ? null : <p className="storage-failure" role="alert">{failure}</p>}
            {measurement === undefined ? (
                <p className="storage-measuring">{measuring ? "Measuring the home…" : "No measurement yet."}</p>
            ) : (
                <>
                    <div className="storage-total">
                        <span className="storage-total-label">Disk space used</span>
                        <span className="storage-total-size">
                            {measurement.partial ? "at least " : ""}
                            {storageSize(total)}
                        </span>
                    </div>
                    <div className="storage-checked">
                        {checkedLabel(measurement.measured_at, Date.now())}
                        {measuring ? " · measuring again…" : ""}
                    </div>
                    <div className="storage-bar" role="img" aria-label="Space used by category">
                        {rows.map(({ area, color, part }) => (
                            <span
                                key={area}
                                className="storage-bar-part"
                                style={{
                                    width: total === 0 ? "0%" : `${Math.max(0.5, (part.bytes / total) * 100)}%`,
                                    background: color,
                                }}
                            />
                        ))}
                    </div>
                    <ul className="storage-legend">
                        {STORAGE_AREA_ROWS.map((row) => {
                            const part = partOf(measurement, row.area);
                            return (
                                <li key={row.area}>
                                    <span className="storage-dot" style={{ background: row.color }} aria-hidden="true" />
                                    <span className="storage-legend-name">{row.label}</span>
                                    <span className="storage-legend-size">{storageSize(part?.bytes ?? 0)}</span>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="storage-rows">
                        {rows.map(({ area, label, color, part }) => (
                            <CategoryRow
                                key={area}
                                label={label}
                                color={color}
                                part={part}
                                {...(area === "scratch" || area === "logs"
                                    ? { onFree: () => onFree(area) }
                                    : {})}
                            />
                        ))}
                    </div>
                    <div className="storage-outside">
                        <div className="storage-outside-note">Outside the home</div>
                        <CategoryRow
                            label={OLD_SCRATCH_ROW.label}
                            color={OLD_SCRATCH_ROW.color}
                            part={{
                                bytes: measurement.old_scratch.bytes,
                                summary: measurement.old_scratch.summary,
                                largest: measurement.old_scratch.largest,
                            }}
                            onFree={() => onFree("old_scratch")}
                        />
                    </div>
                </>
            )}
            <div className="storage-actions">
                <button type="button" className="ghost-btn" onClick={onOpenFolder}>
                    Open folder
                </button>
                <button type="button" className="ghost-btn" onClick={onRefresh} disabled={measuring}>
                    Refresh
                </button>
            </div>
        </>
    );
}

export interface StorageDialogProps {
    readonly bridge: DesktopBridge;
    readonly home: string;
    readonly onClose: () => void;
}

export function StorageDialog({ bridge, home, onClose }: StorageDialogProps) {
    const [measurement, setMeasurement] = useState<StorageMeasurement | undefined>(undefined);
    const [measuring, setMeasuring] = useState(true);
    const [failure, setFailure] = useState<string | undefined>(undefined);
    const [cleanupArea, setCleanupArea] = useState<StorageCleanupArea | undefined>(undefined);
    const request = useRef(0);

    async function load(refresh: boolean): Promise<void> {
        const ticket = ++request.current;
        setMeasuring(true);
        const result = await loadStorage(
            async (again) => measureSafely(bridge, again),
            refresh,
        );
        if (ticket !== request.current) return;
        setMeasuring(false);
        if (result.kind === "ready") {
            setMeasurement(result.measurement);
            setFailure(undefined);
        } else {
            setFailure(result.reason);
        }
    }

    useEffect(() => {
        // The dialog measures once when it opens; after that only Refresh measures.
        void load(false);
    }, []);

    function openFolder(): void {
        void bridge.revealFolder(home).then((opened) => {
            if (!opened) setFailure("The folder could not be opened.");
        }, () => setFailure("The folder could not be opened."));
    }

    return (
        <>
            <OverlaySheet
                title="Storage"
                Icon={LayersIcon}
                name="storage"
                wide
                onClose={onClose}
                onEscape={cleanupArea === undefined ? onClose : () => {}}
            >
                <StorageBody
                    measurement={measurement}
                    measuring={measuring}
                    failure={failure}
                    onRefresh={() => void load(true)}
                    onOpenFolder={openFolder}
                    onFree={setCleanupArea}
                />
            </OverlaySheet>
            {cleanupArea === undefined ? null : (
                <FreeUpSpaceDialog
                    bridge={bridge}
                    area={cleanupArea}
                    onClose={() => setCleanupArea(undefined)}
                    onCleaned={() => void load(true)}
                />
            )}
        </>
    );
}

async function measureSafely(bridge: DesktopBridge, refresh: boolean): Promise<StorageMeasured> {
    try {
        return await bridge.measureStorage(refresh);
    } catch {
        return { ok: false, reason: "The home could not be measured." };
    }
}
