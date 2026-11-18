import { ArrowUpIcon } from "../components/Icons.tsx";
import { openUpdateSheet } from "../overlays/store.ts";
import type { UpdateState } from "../protocol/updates.ts";
import { chipOf } from "./model.ts";
import { useUpdateState } from "./store.ts";

// Sits under the connection state at the bottom of the sidebar and opens the update sheet. Draws nothing when there is no update to offer.
export function UpdateChip() {
    return <UpdateChipButton state={useUpdateState()} />;
}

export function UpdateChipButton({ state }: { readonly state: UpdateState }) {
    const chip = chipOf(state);
    if (chip === undefined) return null;
    return (
        <button type="button" className="update-chip" data-item="update" data-busy={chip.busy} title={chip.title} onClick={openUpdateSheet}>
            <ArrowUpIcon className="update-chip-icon" />
            {chip.label}
        </button>
    );
}
