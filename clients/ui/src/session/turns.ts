import { type FileChange, collectChanges } from "./changes.ts";
import type { Block, TextBlock, UserBlock } from "./model.ts";

export interface Turn {
    readonly key: string;
    readonly user?: UserBlock;
    readonly work: readonly Block[];
    readonly answer?: TextBlock;
}

export interface TurnRender {
    readonly turn: Turn;
    // Changed files of each run of work, keyed by the index of the run's last block in `turn.work`.
    readonly rollups: ReadonlyMap<number, readonly FileChange[]>;
}

// A user block starts a turn; the trailing text of a turn is its answer and the rest is work.
export function toTurns(blocks: readonly Block[]): Turn[] {
    const turns: Turn[] = [];
    let user: UserBlock | undefined;
    let work: Block[] = [];
    let key = "start";
    const push = (): void => {
        if (user === undefined && work.length === 0) return;
        const last = work[work.length - 1];
        if (last !== undefined && last.kind === "text") turns.push({ key, user, work: work.slice(0, -1), answer: last });
        else turns.push({ key, user, work });
    };
    for (const block of blocks) {
        if (block.kind === "user") {
            push();
            user = block;
            work = [];
            key = block.key;
            continue;
        }
        if (user === undefined && work.length === 0) key = block.key;
        work.push(block);
    }
    push();
    return turns;
}

function isRunBlock(block: Block): boolean {
    return block.kind === "tools" || block.kind === "thought";
}

// A run is consecutive tool and thought blocks; any other block closes it.
function runRollups(work: readonly Block[]): ReadonlyMap<number, readonly FileChange[]> {
    const rollups = new Map<number, readonly FileChange[]>();
    let start = -1;
    const close = (end: number): void => {
        if (start < 0) return;
        const changes = collectChanges(work.slice(start, end));
        if (changes.length > 0) rollups.set(end - 1, changes);
        start = -1;
    };
    work.forEach((block, index) => {
        if (!isRunBlock(block)) {
            close(index);
            return;
        }
        if (start < 0) start = index;
    });
    close(work.length);
    return rollups;
}

function sameTurn(a: Turn, b: Turn): boolean {
    if (a.user !== b.user || a.answer !== b.answer || a.work.length !== b.work.length) return false;
    return a.work.every((block, index) => block === b.work[index]);
}

// Reuses the previous render of every turn whose blocks are the same objects, so only a changed turn draws again.
export function keepTurns(
    previous: ReadonlyMap<string, TurnRender>,
    blocks: readonly Block[],
): { readonly renders: readonly TurnRender[]; readonly byKey: ReadonlyMap<string, TurnRender> } {
    const byKey = new Map<string, TurnRender>();
    const renders = toTurns(blocks).map((turn) => {
        const kept = previous.get(turn.key);
        const render = kept !== undefined && sameTurn(kept.turn, turn) ? kept : { turn, rollups: runRollups(turn.work) };
        byKey.set(turn.key, render);
        return render;
    });
    return { renders, byKey };
}
