import { ArrowUpIcon } from "../components/Icons.tsx";
import { OverlaySheet } from "../overlays/OverlaySheet.tsx";
import type { UpdateState } from "../protocol/updates.ts";
import { sheetOf, type UpdateSheetView } from "./model.ts";
import { actOnUpdate, useUpdateState } from "./store.ts";

export interface UpdateSheetProps {
    readonly onClose: () => void;
}

export interface UpdateSheetFrameProps extends UpdateSheetProps {
    readonly state: UpdateState;
}

function UpdateButtons({ view, close }: { readonly view: UpdateSheetView; readonly close: () => void }) {
    if (view.kind === "offer") {
        return (
            <>
                <button type="button" className="session-button" data-action="later" onClick={close}>Later</button>
                <button type="button" className="button-primary session-sheet-action" data-action="update" onClick={() => actOnUpdate({ kind: "run" })}>Update now</button>
            </>
        );
    }
    if (view.kind === "working") {
        return view.cancellable ? <button type="button" className="session-button" data-action="cancel" onClick={() => actOnUpdate({ kind: "cancel" })}>Cancel</button> : null;
    }
    return (
        <>
            {view.kind === "ended" && view.retry ? (
                <button type="button" className="button-primary session-sheet-action" data-action="update" onClick={() => actOnUpdate({ kind: "run" })}>
                    {view.result === "failed" ? "Try again" : "Update now"}
                </button>
            ) : null}
            <button type="button" className="session-button" data-action="close" onClick={close}>Close</button>
        </>
    );
}

function UpdateBody({ view }: { readonly view: UpdateSheetView }) {
    switch (view.kind) {
        case "offer":
            return (
                <>
                    {view.lines.map((line) => <p key={line} className="dialog-text">{line}</p>)}
                    <p className="dialog-text">{view.note}</p>
                </>
            );
        case "working":
            return (
                <div className="update-progress" data-phase={view.heading}>
                    <p className="dialog-text update-heading">{view.heading}</p>
                    {view.fraction === undefined ? null : <progress className="update-bar" max={1} value={view.fraction} aria-label={view.heading} />}
                    {view.detail === undefined ? null : <p className="dialog-text">{view.detail}</p>}
                    {view.sessions.length === 0 ? null : (
                        <ul className="update-sessions">
                            {view.sessions.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}
                        </ul>
                    )}
                </div>
            );
        case "ended":
            return (
                <div className="update-outcome" data-result={view.result}>
                    <p className="dialog-text update-heading">{view.heading}</p>
                    {view.detail === undefined ? null : <p className="dialog-text">{view.detail}</p>}
                </div>
            );
        case "none":
            return <p className="dialog-text">{view.text}</p>;
    }
}

// The sheet the sidebar's update chip opens: the offer, the run's progress, then how the run ended.
export function UpdateSheet({ onClose }: UpdateSheetProps) {
    return <UpdateSheetFrame state={useUpdateState()} onClose={onClose} />;
}

export function UpdateSheetFrame({ state, onClose }: UpdateSheetFrameProps) {
    const view = sheetOf(state);
    // Closing an outcome clears it, so the next opening starts from the offer.
    const close = (): void => {
        if (state.run.kind === "ended") actOnUpdate({ kind: "dismiss" });
        onClose();
    };
    return (
        <OverlaySheet
            title="Update Vera"
            Icon={ArrowUpIcon}
            onClose={close}
            name="update"
            foot={<UpdateButtons view={view} close={close} />}
        >
            <UpdateBody view={view} />
        </OverlaySheet>
    );
}
