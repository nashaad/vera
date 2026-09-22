// Labels are sample text so the sketch reads, not a copy of the real screen. Unlabelled rows draw as bars.
export interface SketchRow {
    label?: string;
    // The part of the label that matches the search, drawn brighter.
    hit?: string;
    active?: boolean;
    favorite?: boolean;
}

export interface SketchField {
    label: string;
    focused?: boolean;
    filled?: boolean;
}

export interface SketchDialog {
    title?: string;
    // '' shows the Search placeholder.
    search?: string;
    searchFocused?: boolean;
    fields?: SketchField[];
    rows?: SketchRow[];
}

// Mirrors the TUI's single queue line: `queued · <first prompt> · +N`.
export interface SketchQueue {
    phase: 'queued' | 'sending';
    prompt: string;
    more: number;
}

// A page replaces the conversation inside the main box; the composer stays below it.
export interface SketchPage {
    focus: 'left' | 'right';
    activeRow: number;
    openRow: number;
}

// Key caps show on the frame before the step, where the key is pressed. Without an anchor they sit on the
// dialog, the focused pane, or the composer.
export type KeysAnchor = 'composer' | 'dialog' | 'header' | 'patch' | 'tree';

// Each step pairs what the reader does (`action`, pressing `keys`) with what the frame now shows (`result`).
export interface ScreenStep {
    action?: string;
    keys: string[];
    keysAt?: KeysAnchor;
    result?: string;
    composer: string;
    composerFocused: boolean;
    conversation?: 'first' | 'second' | 'steering' | 'steered' | 'sent';
    header?: SketchHeader;
    working?: boolean;
    queue?: SketchQueue;
    dialog?: SketchDialog;
    page?: SketchPage;
}

export interface SketchHeader {
    name: string;
    status?: string;
}

export interface ScreenSteps {
    title: string;
    steps: ScreenStep[];
}

export type ScreenStepsName =
    | 'command-palette'
    | 'switch-model'
    | 'resume-conversation'
    | 'keep-running'
    | 'add-provider'
    | 'queued-messages'
    | 'workspace-diff';

export const DIFF_FILES = ['src/map.ts', 'src/treasure.ts', 'test/map.test.ts', 'README.md'];

function active<T extends { active?: boolean }>(rows: T[], at: number): T[] {
    return rows.map((row, index) => ({ ...row, active: index === at }));
}

const COMMANDS: SketchRow[] = [
    { label: 'Switch model' },
    { label: 'Switch conversation' },
    { label: 'Open settings' },
    { label: 'Search past work' },
    { label: 'Show work' },
];

const COMMANDS_TYPED: SketchRow[] = [
    { label: 'Switch model', hit: 'Sw' },
    { label: 'Switch conversation', hit: 'Sw' },
    { label: 'Switch agents', hit: 'Sw' },
];

const MODELS: SketchRow[] = [
    { label: 'model-large', favorite: true },
    { label: 'model-fast' },
    { label: 'model-mini' },
    { label: 'local-model' },
    { label: 'model-vision' },
];

const MODELS_TYPED: SketchRow[] = [
    { label: 'model-large', hit: 'large' },
    { label: 'model-large-preview', hit: 'large' },
    { label: 'jollyroger/model-large', hit: 'large' },
];

const EFFORT_ROWS: SketchRow[] = [{ label: 'low' }, { label: 'medium' }, { label: 'high' }];

const CONVERSATIONS: SketchRow[] = [
    { label: 'A · Chart the route to the island' },
    { label: 'B · Count the shiny coins' },
    { label: 'Patch the crow\'s nest' },
    { label: 'Teach the parrot to sort' },
    { label: 'Bury the spare buttons' },
];

const LEAVE: SketchRow[] = [{ label: 'Stop & switch' }, { label: 'Switch, keep running' }];

const PROVIDERS: SketchRow[] = [{ label: 'OpenRouter · API key' }, { label: 'Add provider' }];

function picker(at: number): SketchDialog {
    return { title: 'Switch conversation', search: '', searchFocused: true, rows: active(CONVERSATIONS, at) };
}

function models(at: number): SketchDialog {
    return { title: 'Switch model', search: '', searchFocused: true, rows: active(MODELS, at) };
}

function modelsTyped(at: number): SketchDialog {
    return { title: 'Switch model', search: 'large', searchFocused: true, rows: active(MODELS_TYPED, at) };
}

const EFFORT: SketchDialog = { title: 'Reasoning effort', rows: active(EFFORT_ROWS, 1) };

export const screenSteps: Record<ScreenStepsName, ScreenSteps> = {
    'command-palette': {
        title: 'Run a command from the palette',
        steps: [
            { action: 'Start in the composer.', keys: [], composer: '', composerFocused: true },
            {
                action: 'Or enter `/palette`.',
                keys: ['Ctrl+P'],
                result: 'Commands opens over the conversation with Search focused.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Commands', search: '', searchFocused: true, rows: active(COMMANDS, 0) },
            },
            {
                action: 'Type part of a command name.',
                keys: [],
                result: 'The list narrows to matching commands.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Commands', search: 'Sw', searchFocused: true, rows: active(COMMANDS_TYPED, 0) },
            },
            {
                keys: ['Down'],
                result: 'The highlight moves to the next match.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Commands', search: 'Sw', searchFocused: true, rows: active(COMMANDS_TYPED, 1) },
            },
            {
                keys: ['Enter'],
                result: 'The highlighted command runs and opens its screen. Escape returns to the composer.',
                composer: '',
                composerFocused: false,
                dialog: picker(0),
            },
        ],
    },
    'switch-model': {
        title: 'Switch the model for this conversation',
        steps: [
            { action: 'Type `/model` in the composer.', keys: [], composer: '/model', composerFocused: true },
            {
                keys: ['Enter'],
                result: 'Switch model opens. Favorites come first, then recent models, then every connected model.',
                composer: '',
                composerFocused: false,
                dialog: models(0),
            },
            {
                action: 'Type part of a model name.',
                keys: [],
                result: 'The list narrows. Search covers every connected model, not only favorites.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(0),
            },
            {
                keys: ['Down'],
                result: 'The highlight moves to the next match.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(1),
            },
            {
                keys: ['Enter'],
                result: 'If the model offers effort levels, Vera asks for one.',
                composer: '',
                composerFocused: false,
                dialog: EFFORT,
            },
            {
                action: 'Choose an effort level.',
                keys: ['Enter'],
                result: 'Back in the composer. The next request uses the new model.',
                composer: '',
                composerFocused: true,
            },
        ],
    },
    'resume-conversation': {
        title: 'Resume another conversation',
        steps: [
            {
                action: 'Type `/resume`. Ctrl+E does the same.',
                keys: [],
                composer: '/resume',
                composerFocused: true,
                header: { name: 'A' },
            },
            {
                keys: ['Enter'],
                result: 'The picker lists your conversations.',
                composer: '',
                composerFocused: false,
                header: { name: 'A' },
                dialog: picker(0),
            },
            {
                action: 'Choose a conversation.',
                keys: ['Down'],
                result: 'The highlight moves to the next one.',
                composer: '',
                composerFocused: false,
                header: { name: 'A' },
                dialog: picker(1),
            },
            {
                keys: ['Enter'],
                result: 'B opens in place of A.',
                composer: '',
                composerFocused: true,
                header: { name: 'B' },
                conversation: 'second',
            },
        ],
    },
    'keep-running': {
        title: 'Leave a conversation running and switch',
        steps: [
            {
                action: 'While A is working, type `/resume`.',
                keys: [],
                composer: '/resume',
                composerFocused: true,
                header: { name: 'A', status: 'working' },
                working: true,
            },
            {
                keys: ['Enter'],
                result: 'The picker lists your conversations.',
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: picker(0),
            },
            {
                action: 'Choose conversation B.',
                keys: ['Down'],
                result: 'The highlight moves to B.',
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: picker(1),
            },
            {
                keys: ['Enter'],
                result: 'A is still working, so Vera asks what happens to it.',
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: { title: 'Leave A?', rows: active(LEAVE, 0) },
            },
            {
                action: 'To keep A running, choose Switch, keep running.',
                keys: ['Down'],
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: { title: 'Leave A?', rows: active(LEAVE, 1) },
            },
            {
                keys: ['Enter'],
                result: 'B opens. A keeps working in the background.',
                composer: '',
                composerFocused: true,
                header: { name: 'B' },
                conversation: 'second',
            },
            {
                keys: ['Ctrl+Shift+Left'],
                keysAt: 'header',
                result: 'Back in A, still working, without opening the picker.',
                composer: '',
                composerFocused: true,
                header: { name: 'A', status: 'working' },
                working: true,
            },
            {
                keys: ['Ctrl+Shift+Right'],
                keysAt: 'header',
                result: 'And over to B again. These keys cycle through every live conversation.',
                composer: '',
                composerFocused: true,
                header: { name: 'B' },
                conversation: 'second',
            },
        ],
    },
    'add-provider': {
        title: 'Connect a provider, then use one of its models',
        steps: [
            {
                action: 'Open the palette and choose Configure providers.',
                keys: ['Ctrl+P'],
                result: 'Your connections are listed, with Add provider at the end.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Configure providers', rows: active(PROVIDERS, 0) },
            },
            {
                keys: ['Down'],
                result: 'Add provider is highlighted.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Configure providers', rows: active(PROVIDERS, 1) },
            },
            {
                keys: ['Enter'],
                result: 'The Add provider form opens. Known providers prefill the endpoint.',
                composer: '',
                composerFocused: false,
                dialog: {
                    title: 'Add provider',
                    fields: [{ label: 'Name', focused: true }, { label: 'Endpoint' }, { label: 'API key' }],
                },
            },
            {
                action: 'Fill in the form, then save.',
                keys: ['Enter'],
                result: 'Vera reads the catalog and reports how many models it found.',
                composer: '',
                composerFocused: false,
                dialog: {
                    title: 'Configure providers',
                    rows: [{ label: 'OpenRouter · API key' }, { label: 'Jolly Roger · 42 models', active: true }, { label: 'Add provider' }],
                },
            },
            {
                action: 'Close it, then enter `/model`.',
                keys: ['Escape'],
                result: 'Switch model opens.',
                composer: '',
                composerFocused: false,
                dialog: models(0),
            },
            {
                action: 'Type part of a model name.',
                keys: [],
                result: 'Search includes the new provider\'s models.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(0),
            },
            {
                keys: ['Down', 'Down'],
                result: 'The new provider\'s model is highlighted.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(2),
            },
            {
                action: 'Optional.',
                keys: ['Ctrl+F'],
                result: 'The highlighted model is now a favorite (★). Favorites list first next time.',
                composer: '',
                composerFocused: false,
                dialog: {
                    ...modelsTyped(2),
                    rows: active(MODELS_TYPED, 2).map((row, index) => (index === 2 ? { ...row, favorite: true } : row)),
                },
            },
            {
                keys: ['Enter'],
                result: 'If the model offers effort levels, Vera asks for one.',
                composer: '',
                composerFocused: false,
                dialog: EFFORT,
            },
            {
                action: 'Choose an effort level.',
                keys: ['Enter'],
                result: 'Back in the composer. The next request uses the new model.',
                composer: '',
                composerFocused: true,
            },
        ],
    },
    'queued-messages': {
        title: 'Queue follow-ups while Vera works',
        steps: [
            {
                action: 'While Vera works, type a follow-up.',
                keys: [],
                result: 'The turn keeps running.',
                composer: 'also mark the X',
                composerFocused: true,
                working: true,
            },
            {
                keys: ['Enter'],
                result: 'The prompt is queued, not sent. The line above the composer shows it.',
                composer: '',
                composerFocused: true,
                working: true,
                queue: { phase: 'queued', prompt: 'also mark the X', more: 0 },
            },
            {
                action: 'With the composer empty.',
                keys: ['Escape'],
                result: 'Vera stops the turn and sends the oldest queued prompt. The answer picks up from there.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steering',
            },
            {
                action: 'To send several at once, queue another follow-up.',
                keys: [],
                composer: 'then hide the map',
                composerFocused: true,
                working: true,
                conversation: 'steered',
            },
            {
                keys: ['Enter'],
                result: 'It waits in the queue.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'queued', prompt: 'then hide the map', more: 0 },
            },
            {
                action: 'And one more.',
                keys: [],
                composer: 'and feed the parrot',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'queued', prompt: 'then hide the map', more: 0 },
            },
            {
                keys: ['Enter'],
                result: '`+1` means one more is waiting. Queued prompts wait for you, even after the turn ends.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'queued', prompt: 'then hide the map', more: 1 },
            },
            {
                action: 'With the composer empty.',
                keys: ['Enter'],
                result: 'Vera stops the turn and sends the whole queue.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'sending', prompt: 'then hide the map', more: 1 },
            },
            {
                keys: [],
                result: 'Both prompts arrive as separate messages, and Vera answers them together.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'sent',
            },
        ],
    },
    'workspace-diff': {
        title: 'Browse workspace changes',
        steps: [
            { action: 'Type `/diff` in the composer.', keys: [], composer: '/diff', composerFocused: true },
            {
                keys: ['Enter'],
                result: 'Patches on the left, the file tree on the right.',
                composer: '',
                composerFocused: false,
                page: { focus: 'right', activeRow: 0, openRow: 0 },
            },
            {
                action: 'Choose a file in the tree.',
                keys: ['Down'],
                result: 'The highlight moves down the tree.',
                composer: '',
                composerFocused: false,
                page: { focus: 'right', activeRow: 1, openRow: 0 },
            },
            {
                keys: ['Enter'],
                result: 'Its patch opens on the left.',
                composer: '',
                composerFocused: false,
                page: { focus: 'right', activeRow: 1, openRow: 1 },
            },
            {
                keys: ['Tab'],
                result: 'Focus moves to the patch. PageUp and PageDown scroll it.',
                composer: '',
                composerFocused: false,
                page: { focus: 'left', activeRow: 1, openRow: 1 },
            },
            {
                action: 'Or Q.',
                keys: ['Escape'],
                result: 'Back in the conversation.',
                composer: '',
                composerFocused: true,
            },
        ],
    },
};
