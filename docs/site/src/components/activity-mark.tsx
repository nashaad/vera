import { useEffect, useRef, useState } from 'react';
import {
    renderTuiActivityBar,
    tuiActivityBarColumns,
    type TuiActivityBarCell,
    type TuiActivityKind,
    type TuiAnimationLevel,
} from '../../../../clients/tui/activity-bar.ts';

// Waiting gets one full breath: the TUI's sin(frame * 0.08) at 60ms frames.
const KINDS: readonly { kind: TuiActivityKind; ms: number }[] = [
    { kind: 'waiting', ms: 4712 },
    { kind: 'thinking', ms: 3200 },
    { kind: 'reading', ms: 3200 },
    { kind: 'running', ms: 3200 },
    { kind: 'writing', ms: 3200 },
];
const CYCLE_MS = KINDS.reduce((total, entry) => total + entry.ms, 0);
// Starts waiting at the bottom of its breath, so it fades up from dim.
const TROUGH_MS = -1178;
const LEVEL: TuiAnimationLevel = 2;
const ACTIVE = '#ecebe6';
// Only the low end of the waiting breath; empty cells are left clear.
const DIM = '#3a3b3e';
const CELL_WIDTH = 9;
const CELL_HEIGHT = 24;
const CELL_GAP = 0;

const RISE = '▁▂▃▄▅▆▇█';
const FILL = '▏▎▍▌▋▊▉█';
// The TUI's font draws shade glyphs solid; strength is already in the colour.
const SHADES = '░▒▓█';

// Each terminal glyph becomes geometry; empty cells stay transparent.
function drawCell(context: CanvasRenderingContext2D, cell: TuiActivityBarCell, x: number): void {
    const w = CELL_WIDTH;
    const h = CELL_HEIGHT;
    context.fillStyle = cell.color;
    const glyph = cell.glyph;
    const rise = RISE.indexOf(glyph);
    const fill = FILL.indexOf(glyph);
    if (SHADES.includes(glyph)) {
        context.fillRect(x, 0, w, h);
    } else if (rise >= 0) {
        const top = h * (rise + 1) / 8;
        context.fillRect(x, h - top, w, top);
    } else if (fill >= 0) {
        context.fillRect(x, 0, w * (fill + 1) / 8, h);
    } else if (glyph === '▚') {
        context.fillRect(x, 0, w / 2, h / 2);
        context.fillRect(x + w / 2, h / 2, w / 2, h / 2);
    } else if (glyph === '▖') {
        context.fillRect(x, h / 2, w / 2, h / 2);
    } else if (glyph === '·') {
        context.fillRect(x + w / 2 - 1, h / 2 - 1, 2, 2);
    }
}

export function ActivityMark() {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [kind, setKind] = useState<TuiActivityKind>('waiting');

    useEffect(() => {
        const element = canvas.current;
        const context = element?.getContext('2d');
        if (!element || !context) return;
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const level: TuiAnimationLevel = still ? 0 : LEVEL;
        const columns = tuiActivityBarColumns(level);
        const width = columns * (CELL_WIDTH + CELL_GAP) - CELL_GAP;
        const ratio = window.devicePixelRatio || 1;
        element.width = width * ratio;
        element.height = CELL_HEIGHT * ratio;
        element.style.width = `${width}px`;
        element.style.height = `${CELL_HEIGHT}px`;

        let frame = 0;
        let shown: TuiActivityKind | undefined;
        function paint(now: number): void {
            let elapsed = now % CYCLE_MS;
            let current: TuiActivityKind = 'waiting';
            for (const entry of KINDS) {
                current = entry.kind;
                if (elapsed < entry.ms) break;
                elapsed -= entry.ms;
            }
            if (current !== shown) {
                shown = current;
                setKind(current);
            }
            const clock = current === 'waiting' ? elapsed + TROUGH_MS : elapsed;
            const cells = renderTuiActivityBar(current, level, clock, { active: ACTIVE, dim: DIM });
            context!.setTransform(ratio, 0, 0, ratio, 0, 0);
            context!.clearRect(0, 0, width, CELL_HEIGHT);
            cells.forEach((cell, index) => drawCell(context!, cell, index * (CELL_WIDTH + CELL_GAP)));
            if (!still) frame = requestAnimationFrame(paint);
        }
        frame = requestAnimationFrame(paint);
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <span className="activity-mark" aria-hidden="true">
            <canvas ref={canvas} />
            <span className="activity-mark-label">{kind}</span>
        </span>
    );
}
