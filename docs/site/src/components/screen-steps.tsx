import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, SkipBack } from 'lucide-react';
import { DIFF_FILES, screenSteps, type KeysAnchor, type ScreenStep, type ScreenStepsName, type SketchDialog, type SketchPage, type SketchRow } from '../data/screen-steps';
import '../styles/screen-steps.css';

const STEP_MS = 1800;
const KEY_MS = 550;
const TYPE_MS = 70;
const STREAM_MS = 45;

// The frame a widget starts from when its first step already needs a key.
const START: ScreenStep = { keys: [], composer: '', composerFocused: true };

interface ScreenStepsProps {
    name: string;
}

// Captions mark code with backticks.
function Inline({ text }: { text: string }) {
    const parts = text.split('`');
    return <>{parts.map((part, index) => index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>)}</>;
}

function keysAnchor(frame: ScreenStep, keysAt: KeysAnchor | undefined): KeysAnchor {
    if (keysAt === 'header' && frame.header) return 'header';
    if (frame.dialog) return 'dialog';
    if (frame.page) return frame.page.focus === 'left' ? 'patch' : 'tree';
    return 'composer';
}

// Up and Down move the highlight on the frame they are pressed on.
function keyDelta(keys: string[]): number {
    return keys.filter((key) => key === 'Down').length - keys.filter((key) => key === 'Up').length;
}

function moveHighlight(frame: ScreenStep, delta: number): ScreenStep {
    if (delta === 0) return frame;
    if (frame.dialog?.rows) {
        const rows = frame.dialog.rows;
        const from = Math.max(rows.findIndex((row) => row.active), 0);
        const to = Math.min(Math.max(from + delta, 0), rows.length - 1);
        return { ...frame, dialog: { ...frame.dialog, rows: rows.map((row, index) => ({ ...row, active: index === to })) } };
    }
    if (frame.page && frame.page.focus === 'right') {
        const to = Math.min(Math.max(frame.page.activeRow + delta, 0), DIFF_FILES.length - 1);
        return { ...frame, page: { ...frame.page, activeRow: to } };
    }
    return frame;
}

// The frame remounts per step, so the pop animation replays.
function Keys({ keys }: { keys: string[] }) {
    return <span className="sketch-keys">{keys.map((key, index) => <kbd key={index}>{key}</kbd>)}</span>;
}

// Reveals text one character at a time: typing in the composer, streaming in a reply.
// Waits for `run`, so a widget below the fold is not already typed when it scrolls in.
function Typed({ text, ms = TYPE_MS, run }: { text: string; ms?: number; run: boolean }) {
    const [shown, setShown] = useState(0);
    useEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setShown(text.length);
            return;
        }
        if (!run) return;
        const timer = window.setInterval(() => setShown((count) => Math.min(count + 1, text.length)), ms);
        return () => window.clearInterval(timer);
    }, [text, ms, run]);
    return <>{text.slice(0, shown)}</>;
}

function Bar({ width }: { width: string }) {
    return <span className="sketch-bar" style={{ width }} />;
}

const ROW_WIDTHS = ['46%', '34%', '52%', '28%', '40%'];

interface SketchLine {
    you: boolean;
    text: string;
    stream?: boolean;
}

const CONVERSATIONS: Record<'first' | 'second' | 'steering' | 'steered' | 'sent', SketchLine[]> = {
    first: [
        { you: true, text: 'chart the route to the island' },
        { you: false, text: 'Reading src/map.ts for the reef markers.' },
        { you: false, text: 'Two routes miss the reef. The north one is shorter.' },
        { you: true, text: 'take the north route' },
        { you: false, text: 'Updating the route in src/map.ts.' },
    ],
    second: [
        { you: true, text: 'count the shiny coins' },
        { you: false, text: 'Found three chests in src/treasure.ts.' },
        { you: false, text: 'Total: 1,204 coins and 17 buttons.' },
        { you: false, text: 'The buttons are not coins.' },
    ],
    steering: [
        { you: true, text: 'chart the route to the island' },
        { you: false, text: 'Two routes miss the reef. The north one is shorter.' },
        { you: true, text: 'also mark the X' },
        { you: false, text: 'Marking the X at the north cove.', stream: true },
    ],
    steered: [
        { you: true, text: 'chart the route to the island' },
        { you: false, text: 'Two routes miss the reef. The north one is shorter.' },
        { you: true, text: 'also mark the X' },
        { you: false, text: 'Marking the X at the north cove.' },
    ],
    sent: [
        { you: true, text: 'chart the route to the island' },
        { you: true, text: 'also mark the X' },
        { you: false, text: 'Marked the X at the north cove.' },
        { you: true, text: 'then hide the map' },
        { you: true, text: 'and feed the parrot' },
        { you: false, text: 'Hid the map and fed the parrot.', stream: true },
    ],
};

const TITLES: Record<string, string> = {
    A: 'Chart the route to the island',
    B: 'Count the shiny coins',
};

function Row({ row, index }: { row: SketchRow; index: number }) {
    let body;
    if (row.label !== undefined && row.hit && row.label.includes(row.hit)) {
        const at = row.label.indexOf(row.hit);
        body = <span>{row.label.slice(0, at)}<span className="sketch-hit">{row.hit}</span>{row.label.slice(at + row.hit.length)}</span>;
    } else if (row.label !== undefined) {
        body = <span>{row.label}</span>;
    } else {
        body = <Bar width={ROW_WIDTHS[index % ROW_WIDTHS.length]} />;
    }
    return (
        <li className={row.active ? 'active' : undefined}>
            <span className="sketch-pointer">{row.active ? '›' : ' '}</span>
            <span className="sketch-star">{row.favorite ? '★' : ''}</span>
            {body}
        </li>
    );
}

function Dialog({ dialog, keys }: { dialog: SketchDialog; keys?: ReactNode }) {
    return (
        <div className="sketch-dialog">
            <div className="sketch-dialog-title">
                {dialog.title !== undefined ? <span>{dialog.title}</span> : <span className="sketch-title-bar"><Bar width="100%" /></span>}
                <span className="sketch-dim">esc</span>
            </div>
            {dialog.search !== undefined && (
                <div className="sketch-search">
                    {dialog.search}
                    {dialog.searchFocused && <span className="sketch-caret" />}
                    {dialog.search === '' && <span className="sketch-dim">Search</span>}
                </div>
            )}
            {dialog.fields && (
                <div className="sketch-fields">
                    {dialog.fields.map((field, index) => (
                        <div key={index} className={field.focused ? 'sketch-field focused' : 'sketch-field'}>
                            <span className="sketch-field-label">{field.label}</span>
                            <span className="sketch-field-input">
                                {field.filled && <span className="sketch-typed" />}
                                {field.focused && <span className="sketch-caret" />}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {dialog.rows && (
                <ul className="sketch-rows">
                    {dialog.rows.map((row, index) => <Row key={index} row={row} index={index} />)}
                </ul>
            )}
            {keys}
        </div>
    );
}

function Page({ page, keys, anchor }: { page: SketchPage; keys?: ReactNode; anchor: KeysAnchor }) {
    const patch = ['+', '+', ' ', '-', '+', ' ', '-'];
    return (
        <div className="sketch-page">
            <div className={page.focus === 'left' ? 'sketch-pane focused' : 'sketch-pane'}>
                {patch.map((mark, index) => (
                    <div key={index} className="sketch-line">
                        <span className={mark === '+' ? 'sketch-mark add' : mark === '-' ? 'sketch-mark del' : 'sketch-mark'}>{mark}</span>
                        <Bar width={ROW_WIDTHS[(index + page.openRow) % ROW_WIDTHS.length]} />
                    </div>
                ))}
                {anchor === 'patch' && keys}
            </div>
            <ul className={page.focus === 'right' ? 'sketch-pane sketch-rows focused' : 'sketch-pane sketch-rows'}>
                {DIFF_FILES.map((file, index) => <Row key={file} row={{ label: file, active: index === page.activeRow }} index={index} />)}
                {anchor === 'tree' && keys}
            </ul>
        </div>
    );
}

interface FrameProps {
    step: ScreenStep;
    pressed?: ScreenStep;
    pressedCount?: number;
    typeComposer: boolean;
    live: boolean;
}

// `pressed` is the step whose keys act on this frame; `pressedCount` of them are down so far.
function Frame({ step: base, pressed, pressedCount = 0, typeComposer, live }: FrameProps) {
    const shownKeys = pressed ? pressed.keys.slice(0, pressedCount) : [];
    const step = moveHighlight(base, keyDelta(shownKeys));
    const lines = CONVERSATIONS[step.conversation ?? 'first'];
    const covered = step.dialog !== undefined;
    const anchor = keysAnchor(step, pressed?.keysAt);
    const keys = shownKeys.length > 0 ? <Keys keys={shownKeys} /> : undefined;
    const keysAt = (place: KeysAnchor) => (anchor === place ? keys : undefined);
    return (
        <div className="sketch-screen" aria-hidden="true">
            <div className={covered ? 'sketch-main dimmed' : 'sketch-main'}>
                {step.header && (
                    <div className="sketch-header">
                        <span className="sketch-header-name"><b>{step.header.name}</b> · {TITLES[step.header.name]}</span>
                        {keysAt('header')}
                        {step.header.status && <span className="sketch-dim sketch-status">{step.header.status}</span>}
                    </div>
                )}
                {step.page ? <Page page={step.page} keys={keys} anchor={anchor} /> : lines.map((line, index) => (
                    <div key={index} className={line.you ? 'sketch-line you' : 'sketch-line'}>
                        {line.you && <span className="sketch-prompt">&gt;</span>}
                        <span className="sketch-text">{line.stream ? <Typed text={line.text} ms={STREAM_MS} run={live} /> : line.text}</span>
                    </div>
                ))}
                {step.working && !step.page && <div className="sketch-line sketch-working"><Bar width="12%" /></div>}
                {step.queue && (
                    <div className="sketch-queue">
                        <span className="sketch-queue-phase">{step.queue.phase}</span>
                        <span className="sketch-dim">·</span>
                        <span className="sketch-queue-prompt">{step.queue.prompt}</span>
                        {step.queue.more > 0 && <span className="sketch-dim">· +{step.queue.more}</span>}
                    </div>
                )}
                {step.dialog && <Dialog dialog={step.dialog} keys={keysAt('dialog')} />}
            </div>
            <div className="sketch-composer">
                <span className="sketch-prompt">&gt;</span>
                {typeComposer ? <Typed text={step.composer} run={live} /> : step.composer}
                {step.composerFocused && <span className="sketch-caret" />}
                {keysAt('composer')}
            </div>
        </div>
    );
}

export function ScreenSteps({ name }: ScreenStepsProps) {
    const sequence = screenSteps[name as ScreenStepsName];
    const [index, setIndex] = useState(0);
    const [playing, setPlaying] = useState(false);
    // Keys of the current step pressed so far; 0 means the step's own frame shows.
    const [pressed, setPressed] = useState(sequence?.steps[0].keys.length ? 1 : 0);
    const pressing = pressed > 0;
    const [visible, setVisible] = useState(false);
    const root = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(true);
        const element = root.current;
        if (!element) return;
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.4 });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // Runs while paused too, so Next still shows the key press.
    useEffect(() => {
        if (!pressing || !sequence) return;
        const total = sequence.steps[index].keys.length;
        const timer = window.setTimeout(() => setPressed(pressed >= total ? 0 : pressed + 1), KEY_MS);
        return () => window.clearTimeout(timer);
    }, [pressed, pressing, index, sequence]);

    useEffect(() => {
        if (!playing || !visible || pressing || !sequence) return;
        const last = index === sequence.steps.length - 1;
        const timer = window.setTimeout(() => advance(last ? 0 : index + 1), last ? STEP_MS * 1.6 : STEP_MS);
        return () => window.clearTimeout(timer);
    }, [playing, visible, pressing, index, sequence]);

    function advance(next: number) {
        if (!sequence) return;
        setIndex(next);
        setPressed(sequence.steps[next].keys.length > 0 ? 1 : 0);
    }

    if (!sequence) return null;
    const count = sequence.steps.length;
    const step = sequence.steps[index];
    const before = index > 0 ? sequence.steps[index - 1] : START;

    function goTo(next: number) {
        setPlaying(false);
        setIndex(Math.min(Math.max(next, 0), count - 1));
        setPressed(0);
    }

    function goNext() {
        setPlaying(false);
        advance(index + 1);
    }

    return (
        <figure className="screen-steps" ref={root} aria-label={sequence.title}>
            <figcaption className="screen-steps-title">{sequence.title}</figcaption>
            {pressing
                ? <Frame key={`press-${index}`} step={before} pressed={step} pressedCount={pressed} typeComposer={false} live={visible} />
                : <Frame key={`step-${index}`} step={step} typeComposer={step.composer !== '' && step.composer !== before.composer} live={visible} />}
            {/* Every caption shares one grid cell, so the box is as tall as the longest and the page never jumps. */}
            <div className="screen-steps-caption">
                {sequence.steps.map((each, eachIndex) => (
                    <div key={eachIndex} className={eachIndex === index ? 'current' : undefined} aria-hidden={eachIndex !== index} aria-live={eachIndex === index ? 'polite' : undefined}>
                        {each.action && <p className="screen-steps-action"><Inline text={each.action} /></p>}
                        {each.result && <p className="screen-steps-result"><Inline text={each.result} /></p>}
                    </div>
                ))}
            </div>
            <div className="screen-steps-controls">
                <button type="button" onClick={() => goTo(0)} aria-label="First step" disabled={index === 0}><SkipBack /></button>
                <button type="button" onClick={() => goTo(index - 1)} aria-label="Previous step" disabled={index === 0}><ChevronLeft /></button>
                <button type="button" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause /> : <Play />}</button>
                <button type="button" onClick={goNext} aria-label="Next step" disabled={index === count - 1}><ChevronRight /></button>
                <span className="screen-steps-counter">{index + 1} of {count}</span>
            </div>
        </figure>
    );
}
