import { useEffect, useRef, useState } from "react";

import { WarningIcon } from "../../components/Icons.tsx";
import { OverlaySheet } from "../../overlays/OverlaySheet.tsx";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import type {
    StorageCleaned,
    StorageCleanupArea,
    StorageCleanupPreview,
    StoragePreviewed,
} from "../../protocol/storage.ts";
import { Segmented } from "./Segmented.tsx";
import { storageSize } from "./storage.ts";

const AGES = ["1", "7", "30"] as const;
type Age = (typeof AGES)[number];
const AGE_LABELS: Record<Age, string> = { "1": "1 day", "7": "7 days", "30": "30 days" };
const DEFAULT_AGE: Age = "7";

const AREA_TITLES: Record<StorageCleanupArea, string> = {
    scratch: "Scratch",
    logs: "Logs",
    old_scratch: "Old scratch",
};

function areaCopy(area: StorageCleanupArea, days: number): string {
    if (area === "logs") {
        return `Remove session logs not written in ${days === 1 ? "the last day" : `the last ${days} days`}. Session files and settings stay.`;
    }
    if (area === "old_scratch") {
        return "Remove leftover scratch folders in the temporary Vera directory for sessions that belong to this home.";
    }
    return `Remove scratch folders for sessions not used in ${days === 1 ? "the last day" : `the last ${days} days`}. Session files and history stay.`;
}

function areaNoun(area: StorageCleanupArea, count: number): string {
    if (area === "logs") return count === 1 ? "file" : "files";
    return count === 1 ? "folder" : "folders";
}

export interface CleanupBodyProps {
    readonly area: StorageCleanupArea;
    readonly age: Age;
    readonly preview: StorageCleanupPreview | undefined;
    readonly acknowledged: boolean;
    readonly busy: boolean;
    readonly failure: string | undefined;
    readonly onAgeChange: (age: Age) => void;
    readonly onAcknowledgedChange: (acknowledged: boolean) => void;
    readonly onDelete: () => void;
    readonly onClose: () => void;
}

// The sheet's contents without its frame, so tests can render both confirmation states.
export function CleanupBody({
    area,
    age,
    preview,
    acknowledged,
    busy,
    failure,
    onAgeChange,
    onAcknowledgedChange,
    onDelete,
    onClose,
}: CleanupBodyProps) {
    const days = Number(age);
    return (
        <>
            <p className="storage-lede">{areaCopy(area, days)}</p>
            <div className="storage-cleanup-controls">
                <span className="storage-cleanup-label">Older than</span>
                <Segmented
                    label="Age"
                    options={AGES}
                    labels={AGE_LABELS}
                    value={age}
                    disabled={busy}
                    onChange={onAgeChange}
                />
            </div>
            {failure === undefined ? null : <p className="storage-failure" role="alert">{failure}</p>}
            {preview === undefined ? (
                <p className="storage-measuring">{busy ? "Checking what can be removed…" : "Nothing checked yet."}</p>
            ) : preview.count === 0 ? (
                <p className="storage-cleanup-empty">Nothing older than {AGE_LABELS[age]}.</p>
            ) : (
                <>
                    <div className="storage-cleanup-total">
                        <span>{preview.count} {areaNoun(area, preview.count)}</span>
                        <span>{storageSize(preview.bytes)}</span>
                    </div>
                    {preview.names.length === 0 ? null : (
                        <ul className="storage-cleanup-names">
                            {preview.names.map((name) => (
                                <li key={name}><code>{name}</code></li>
                            ))}
                            {preview.more === 0 ? null : (
                                <li className="storage-cleanup-more">and {preview.more} more</li>
                            )}
                        </ul>
                    )}
                    {preview.partial ? (
                        <p className="storage-cleanup-note">Some folders could not be checked; more may be removed.</p>
                    ) : null}
                    <label className="storage-confirm">
                        <input
                            type="checkbox"
                            checked={acknowledged}
                            disabled={busy}
                            onChange={(event) => onAcknowledgedChange(event.currentTarget.checked)}
                        />
                        <span>I understand this can't be undone</span>
                    </label>
                </>
            )}
            {preview !== undefined && preview.count > 0 ? null : (
                <p className="storage-cleanup-note">Nothing is removed until you choose Delete.</p>
            )}
            <div className="storage-cleanup-actions">
                <button type="button" className="ghost-btn" onClick={onClose} autoFocus>
                    Cancel
                </button>
                <button
                    type="button"
                    className="storage-delete-btn"
                    disabled={!acknowledged || busy || preview === undefined || preview.count === 0}
                    onClick={onDelete}
                >
                    Delete {preview?.count ?? 0} {areaNoun(area, preview?.count ?? 0)}
                </button>
            </div>
        </>
    );
}

export interface FreeUpSpaceDialogProps {
    readonly bridge: DesktopBridge;
    readonly area: StorageCleanupArea;
    readonly onClose: () => void;
    readonly onCleaned: () => void;
}

export function FreeUpSpaceDialog({ bridge, area, onClose, onCleaned }: FreeUpSpaceDialogProps) {
    const [age, setAge] = useState<Age>(DEFAULT_AGE);
    const [preview, setPreview] = useState<StorageCleanupPreview | undefined>(undefined);
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | undefined>(undefined);
    const request = useRef(0);

    async function check(days: number): Promise<void> {
        const ticket = ++request.current;
        setBusy(true);
        setPreview(undefined);
        setAcknowledged(false);
        const outcome = await previewSafely(bridge, area, days);
        if (ticket !== request.current) return;
        setBusy(false);
        if (outcome.ok) {
            setPreview(outcome.preview);
            setFailure(undefined);
        } else {
            setFailure(outcome.reason);
        }
    }

    useEffect(() => {
        void check(Number(age));
        // A new age is the only re-check; every other control acts on the current preview.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [age, area]);

    async function remove(): Promise<void> {
        setBusy(true);
        const outcome = await cleanSafely(bridge, area, Number(age));
        setBusy(false);
        if (!outcome.ok) {
            setFailure(outcome.reason);
            return;
        }
        // The numbers under the dialog are stale after a delete, so refresh them and close.
        onCleaned();
        onClose();
    }

    return (
        <OverlaySheet
            title={AREA_TITLES[area]}
            Icon={WarningIcon}
            name="storage-cleanup"
            onClose={onClose}
        >
            <CleanupBody
                area={area}
                age={age}
                preview={preview}
                acknowledged={acknowledged}
                busy={busy}
                failure={failure}
                onAgeChange={setAge}
                onAcknowledgedChange={setAcknowledged}
                onDelete={() => void remove()}
                onClose={onClose}
            />
        </OverlaySheet>
    );
}

async function previewSafely(
    bridge: DesktopBridge,
    area: StorageCleanupArea,
    maxAgeDays: number,
): Promise<StoragePreviewed> {
    try {
        return await bridge.previewStorageCleanup(area, maxAgeDays);
    } catch {
        return { ok: false, reason: "The cleanup could not be checked." };
    }
}

async function cleanSafely(
    bridge: DesktopBridge,
    area: StorageCleanupArea,
    maxAgeDays: number,
): Promise<StorageCleaned> {
    try {
        return await bridge.runStorageCleanup(area, maxAgeDays);
    } catch {
        return { ok: false, reason: "The cleanup did not finish." };
    }
}
