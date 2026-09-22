import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Pause, Play, SkipBack } from 'lucide-react';
import { CrowMark } from './crow-mark';
import { ContextPanel, ConversationDiagram, type ContextMark } from './conversation-diagram';
import { DIFF_FILES, FLOW_EVENT, screenSteps, type ContextEntry, type ContextMeter, type FlowHighlight, type KeysAnchor, type ScreenStep, type RuleFile, type ScreenSteps as ScreenSequence, type ScreenStepsName, type SketchDialog, type SketchPage, type SketchRow } from '../data/screen-steps';
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

function lineClass(line: SketchLine): string {
    const classes = ['sketch-line'];
    if (line.you) classes.push('you');
    if (line.tool) classes.push('tool');
    if (line.header) classes.push('tool-header');
    if (line.live) classes.push('live');
    if (line.appear) classes.push('appear');
    if (line.notice) classes.push('notice');
    if (line.added) classes.push('added');
    return classes.join(' ');
}

function Bar({ width }: { width: string }) {
    return <span className="sketch-bar" style={{ width }} />;
}

const ROW_WIDTHS = ['46%', '34%', '52%', '28%', '40%'];

interface SketchLine {
    you: boolean;
    text: string;
    stream?: boolean;
    tool?: boolean;
    // A tool group header such as Running or Ran; `live` marks one still running.
    header?: boolean;
    live?: boolean;
    // Fades in instead of typing, for output that lands all at once.
    appear?: boolean;
    // A plain transcript notice, such as an extension's message.
    notice?: boolean;
    // A line an edit added, shown under its tool line.
    added?: boolean;
}

const MAP_ASK: SketchLine = { you: true, text: 'chart the route to the island' };
const MAP_REPLY: SketchLine = { you: false, text: 'The north route is shorter.' };
const BUDGET_SET: SketchLine = { you: false, notice: true, text: 'vera.budget/budget: Budget changed to $3.00. Spent: $1.20. Remaining: $1.80.' };
const REEF_ASK: SketchLine = { you: true, text: 'raid the kraken\'s reef for shiny buttons' };
const REEF_READ: SketchLine = { you: false, text: 'Read src/reef.ts', tool: true };
const BUDGET_HALF: SketchLine = { you: false, notice: true, text: 'Halfway through budget: $1.60 spent of $3.00. $1.40 remaining.' };
const REEF_EDIT: SketchLine = { you: false, text: 'Edit src/loot.ts', tool: true };
const BUDGET_EIGHTY: SketchLine = { you: false, notice: true, text: '80% of budget used: $2.45 spent of $3.00. $0.55 remaining.' };
const LOOT_ASK: SketchLine = { you: true, text: 'stash the gold in the chest' };
const CHEST_READ: SketchLine = { you: false, text: 'Read treasure/chest.yaml', tool: true };

const LEDGER_ASK: SketchLine = { you: true, text: 'tally the loot in treasure/ledger.yaml' };
const LEDGER_READ: SketchLine = { you: false, text: 'Read treasure/ledger.yaml', tool: true };
const LOG_ASK: SketchLine = { you: true, text: "read the ship's log" };
const LOG_READ: SketchLine = { you: false, text: 'Read ship/log.md', tool: true };
const RUM_ASK: SketchLine = { you: true, text: 'stow the rum below deck' };
const COURSE_ASK: SketchLine = { you: true, text: 'plot a course to skull island' };
const MAP_READ: SketchLine = { you: false, text: 'Read maps/skull-island.md', tool: true };
const TOO_BIG: SketchLine = { you: false, notice: true, text: 'Model call failed: the conversation is larger than the context window.' };
const SUMMARIZED: SketchLine = { you: false, notice: true, text: 'Earlier messages were summarized. They are still shown here, but the model now sees the summary instead.' };

const DOUBLOON_ASK: SketchLine = { you: true, text: 'count the doubloons in treasure/chest.yaml' };
const DOUBLOON_READ: SketchLine = { you: false, text: 'Read treasure/chest.yaml', tool: true };
const DOUBLOON_ANSWER: SketchLine = { you: false, text: '40 doubloons in the chest, arr.' };
const PARROT_ASK: SketchLine = { you: true, text: 'hide them from the parrot' };
const PARROT_ANSWER: SketchLine = { you: false, text: "Buried under the crow's nest." };
const SAIL_ASK: SketchLine = { you: true, text: 'sail for skull island' };

const CONVERSATIONS: Record<NonNullable<ScreenStep['conversation']>, SketchLine[]> = {
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
    'tool-start': [],
    'tool-asked': [
        { you: true, text: 'mark the X in src/map.ts and run the tests' },
    ],
    'tool-read': [
        { you: true, text: 'mark the X in src/map.ts and run the tests' },
        { you: false, text: 'Read src/map.ts', tool: true },
    ],
    'tool-edit': [
        { you: true, text: 'mark the X in src/map.ts and run the tests' },
        { you: false, text: 'Read src/map.ts', tool: true },
        { you: false, text: 'Edit src/map.ts', tool: true },
    ],
    'tool-running': [
        { you: true, text: 'mark the X in src/map.ts and run the tests' },
        { you: false, text: 'Read src/map.ts', tool: true },
        { you: false, text: 'Edit src/map.ts', tool: true },
        { you: false, text: 'Running', header: true, live: true },
        { you: false, text: 'bun test', tool: true },
    ],
    'tool-ran': [
        { you: true, text: 'mark the X in src/map.ts and run the tests' },
        { you: false, text: 'Read src/map.ts', tool: true },
        { you: false, text: 'Edit src/map.ts', tool: true },
        { you: false, text: 'Ran  bun test', header: true },
        { you: false, text: '12 pass, 0 fail', tool: true, appear: true },
    ],
    'tool-done': [
        { you: true, text: 'mark the X in src/map.ts and run the tests' },
        { you: false, text: 'Read src/map.ts', tool: true },
        { you: false, text: 'Edit src/map.ts', tool: true },
        { you: false, text: 'Ran  bun test', header: true },
        { you: false, text: '12 pass, 0 fail', tool: true },
        { you: false, text: 'Marked the X at the north cove. The map tests pass.', stream: true },
    ],
    'budget-start': [MAP_ASK, MAP_REPLY],
    'budget-set': [MAP_ASK, MAP_REPLY, BUDGET_SET],
    'budget-half': [MAP_ASK, MAP_REPLY, BUDGET_SET, REEF_ASK, REEF_READ, BUDGET_HALF],
    'budget-eighty': [MAP_ASK, MAP_REPLY, BUDGET_SET, REEF_ASK, REEF_READ, BUDGET_HALF, REEF_EDIT, BUDGET_EIGHTY],
    // The transcript has scrolled, so the oldest lines are gone.
    'budget-continued': [REEF_ASK, REEF_READ, BUDGET_HALF, REEF_EDIT, BUDGET_EIGHTY, { you: false, text: 'Raided the reef: 31 buttons, one very angry kraken.', stream: true }],
    'rules-start': [],
    'rules-asked': [LOOT_ASK],
    'rules-read': [LOOT_ASK, CHEST_READ],
    'rules-done': [
        LOOT_ASK,
        CHEST_READ,
        { you: false, text: 'Edit treasure/chest.yaml', tool: true },
        { you: false, text: '+ decoy_lid: 3 shiny buttons   # gold goes underneath', added: true },
        { you: false, text: 'Stashed the gold under a decoy lid of three shiny buttons.', stream: true },
    ],
    'rules-without': [
        LOOT_ASK,
        CHEST_READ,
        { you: false, text: 'Edit treasure/chest.yaml', tool: true },
        { you: false, text: '+ gold: 500 coins   # right on top', added: true },
        { you: false, text: 'Stashed the gold in the chest.', stream: true },
    ],
    // The transcript has scrolled, so the start of the raid is off screen.
    'fill-ledger': [LEDGER_ASK, LEDGER_READ],
    'fill-log-ask': [LEDGER_ASK, LEDGER_READ, LOG_ASK],
    'fill-log': [LEDGER_ASK, LEDGER_READ, LOG_ASK, LOG_READ],
    // The transcript has scrolled, so the oldest lines are gone.
    'fill-rum': [LEDGER_READ, LOG_ASK, LOG_READ, RUM_ASK],
    'fill-course': [LOG_ASK, LOG_READ, RUM_ASK, COURSE_ASK],
    'fill-map': [LOG_READ, RUM_ASK, COURSE_ASK, MAP_READ],
    'fill-failed': [LOG_READ, RUM_ASK, COURSE_ASK, MAP_READ, TOO_BIG],
    'fill-summarized': [RUM_ASK, COURSE_ASK, MAP_READ, SUMMARIZED],
    'fill-answered': [RUM_ASK, COURSE_ASK, MAP_READ, SUMMARIZED, { you: false, text: 'Course set: two days west, mind the kraken.', stream: true }],
    // The nudge is hidden, so none of these lines show it.
    'nudge-ask': [DOUBLOON_ASK],
    'nudge-read': [DOUBLOON_ASK, DOUBLOON_READ],
    'nudge-answer': [DOUBLOON_ASK, DOUBLOON_READ, { ...DOUBLOON_ANSWER, stream: true }],
    'nudge-parrot': [DOUBLOON_ASK, DOUBLOON_READ, DOUBLOON_ANSWER, PARROT_ASK],
    'nudge-parrot-done': [DOUBLOON_ASK, DOUBLOON_READ, DOUBLOON_ANSWER, PARROT_ASK, { ...PARROT_ANSWER, stream: true }],
    'nudge-sail': [DOUBLOON_READ, DOUBLOON_ANSWER, PARROT_ASK, PARROT_ANSWER, SAIL_ASK],
    'nudge-done': [DOUBLOON_ANSWER, PARROT_ASK, PARROT_ANSWER, SAIL_ASK, { you: false, text: 'Heading west, arr.', stream: true }],
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
            {row.input !== undefined && <span className="sketch-row-input">{row.input}<span className="sketch-caret" /></span>}
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
            {dialog.body && <div className="sketch-dialog-body">{dialog.body}</div>}
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
    const shownKeys = pressed ? pressed.keys.slice(0, pressedCount) : base.held ?? [];
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
                    <div key={index} className={lineClass(line)}>
                        {line.you && <span className="sketch-prompt">&gt;</span>}
                        {line.tool && <span className="sketch-tool-mark">└</span>}
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

function RuleFiles({ files, step }: { files: RuleFile[]; step: number }) {
    return (
        <div className="rule-files" aria-hidden="true">
            <div className="flow-context-title">Rule files</div>
            {files.length === 0 && <div className="rule-file">none</div>}
            {files.map((each) => {
                const classes = ['rule-file'];
                if (step >= each.step) classes.push('is-in');
                if (step === each.step) classes.push('is-new');
                return (
                    <div key={each.file} className={classes.join(' ')}>
                        <span className="flow-context-step">{step >= each.step ? each.step : ''}</span>
                        <span className="rule-file-name">{each.file}</span>
                        <span className="rule-file-folder">for files in {each.folder}</span>
                        <span className="rule-file-text">{each.text}</span>
                    </div>
                );
            })}
        </div>
    );
}

interface ShownContext {
    entries: ContextEntry[];
    fresh: number;
    steps: number[];
    marks?: ContextMark[];
}

function shownContext(sequence: ScreenSequence, index: number): ShownContext {
    const all = sequence.context ?? [];
    const step = sequence.steps[index];
    if (!all.some((entry) => entry.at !== undefined)) {
        return { entries: all.slice(0, step.context ?? 0), fresh: step.fresh ?? 1, steps: arrivals(sequence) };
    }
    const now = index + 1;
    const entries = all.filter((entry) => (entry.at ?? 1) <= now && (entry.gone === undefined || entry.gone > now));
    return {
        entries,
        fresh: 0,
        steps: entries.map((entry) => entry.at ?? 1),
        marks: entries.map((entry) => {
            if (entry.folding === now) return 'folding';
            return now > 1 && entry.at === now ? 'new' : undefined;
        }),
    };
}

function TokenTally({ meter, entries }: { meter: ContextMeter; entries: ContextEntry[] }) {
    const used = entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
    const marks = meter.marks.map((mark) => `${mark.label} at ${mark.percent}%`).join(', ');
    return (
        <div className={used > meter.window ? 'context-tally is-full' : 'context-tally'} aria-hidden="true">
            {used} of {meter.window} crow words{used > meter.window && ', too big to send'}{marks && <span className="context-tally-marks">{marks}</span>}
        </div>
    );
}

function arrivals(sequence: ScreenSequence): number[] {
    const steps: number[] = [];
    sequence.steps.forEach((each, index) => {
        while (steps.length < (each.context ?? 0)) steps.push(index + 1);
    });
    return steps;
}

export function ScreenSteps({ name }: ScreenStepsProps) {
    const sequence = screenSteps[name as ScreenStepsName];
    const [index, setIndex] = useState(0);
    const [playing, setPlaying] = useState(false);
    // Keys of the current step pressed so far; 0 means the step's own frame shows.
    const [pressed, setPressed] = useState(sequence?.steps[0].keys.length ? 1 : 0);
    const pressing = pressed > 0;
    const [visible, setVisible] = useState(false);
    // Wide view shows the diagram beside the screen, for widgets that drive it.
    const [wide, setWide] = useState(false);
    const root = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(true);
    }, []);

    // The figure moves to a new node when wide view toggles, so observe it again.
    useEffect(() => {
        const element = root.current;
        if (!element) return;
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.4 });
        observer.observe(element);
        return () => observer.disconnect();
    }, [wide]);

    useEffect(() => {
        if (!wide) return;
        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') setWide(false);
        }
        window.addEventListener('keydown', onKey);
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = overflow;
        };
    }, [wide]);

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

    // Follows the caption, which switches as the key goes down, so the two numbers always match.
    const shownFlow = sequence && index >= 0 ? sequence.steps[index].flow : undefined;
    const flowing = sequence?.steps.some((each) => each.flow) ?? false;
    const numbered = flowing || sequence?.context !== undefined;
    useEffect(() => {
        if (!flowing) return;
        const detail: FlowHighlight | undefined = shownFlow && { ...shownFlow, step: index + 1 };
        window.dispatchEvent(new CustomEvent<FlowHighlight | undefined>(FLOW_EVENT, { detail }));
        // `wide` is here so the diagram that wide view mounts gets the current step at once.
    }, [shownFlow, index, flowing, wide]);

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

    const shown = shownContext(sequence, index);
    const figure = (
        <figure className={wide && sequence.context ? 'screen-steps wide-context' : 'screen-steps'} ref={root} aria-label={sequence.title}>
            <figcaption className="screen-steps-title">
                {sequence.title}
                {sequence.verdict && <span className={`screen-steps-verdict ${sequence.verdict.tone}`}>{sequence.verdict.text}</span>}
                <CrowMark step={index} playing={playing && visible} />
            </figcaption>
            {sequence.context && (
                <div className="screen-steps-context">
                    {sequence.ruleFiles && <RuleFiles files={sequence.ruleFiles} step={index + 1} />}
                    <ContextPanel entries={shown.entries} count={shown.entries.length} fresh={shown.fresh} steps={shown.steps} marks={shown.marks} meter={sequence.meter} />
                    {sequence.meter && <TokenTally meter={sequence.meter} entries={shown.entries} />}
                </div>
            )}
            {pressing
                ? <Frame key={`press-${index}`} step={before} pressed={step} pressedCount={pressed} typeComposer={false} live={visible} />
                : <Frame key={`step-${index}`} step={step} typeComposer={step.composer !== '' && step.composer !== before.composer} live={visible} />}
            {/* Every caption shares one grid cell, so the box is as tall as the longest and the page never jumps. */}
            <div className="screen-steps-caption">
                {sequence.steps.map((each, eachIndex) => (
                    <div key={eachIndex} className={eachIndex === index ? 'current' : undefined} aria-hidden={eachIndex !== index} aria-live={eachIndex === index ? 'polite' : undefined}>
                        {numbered && <span className="screen-steps-number">{eachIndex + 1}</span>}
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
                {numbered && (
                    <button type="button" className="screen-steps-wide-toggle" onClick={() => setWide(!wide)} aria-label={wide ? 'Close wide view' : 'Wide view'} aria-pressed={wide}>
                        {wide ? <Minimize2 /> : <Maximize2 />}
                        <span>{wide ? 'Close wide view' : 'Wide view'}</span>
                    </button>
                )}
                <span className="screen-steps-counter">{index + 1} of {count}</span>
            </div>
        </figure>
    );

    if (!wide) return figure;
    return (
        <>
            <div className="screen-steps-wide-placeholder">
                <button type="button" onClick={() => setWide(false)}>Close wide view</button>
            </div>
            {createPortal(
                <div className="screen-steps-wide" role="dialog" aria-modal="true" aria-label={sequence.title}>
                    <div className="screen-steps-wide-inner">
                        {flowing && <ConversationDiagram wide />}
                        {figure}
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}
