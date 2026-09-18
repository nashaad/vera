// Every path here must appear in the page named by `documentedIn`.
// src/data/vera-directory.test.ts checks it.

export type Writer = 'you' | 'vera' | 'both';
export type Placement = 'home' | 'committed' | 'local';
export type NodeKind = 'file' | 'directory';
export type TreeName = 'home' | 'project';

export interface DirectoryNode {
    name: string;
    path: string;
    kind: NodeKind;
    writer: Writer;
    placement: Placement;
    summary: string;
    loads: string;
    detail: string;
    example?: string;
    documentedIn: string;
    children?: DirectoryNode[];
}

export interface DirectoryTree {
    name: TreeName;
    label: string;
    root: string;
    intro: string;
    nodes: DirectoryNode[];
}

const homeNodes: DirectoryNode[] = [
    {
        name: 'config.json',
        path: 'config.json',
        kind: 'file',
        writer: 'both',
        placement: 'home',
        summary: 'Provider, permission, model, extension, and hook settings.',
        loads: 'Read by the host and the terminal UI. Settings screens write it and validate each change.',
        detail: 'The home settings file. Prefer `/settings` or the feature screen for a setting that has one. `/configure` opens this file in your editor for the rest. Context limits, compaction, and tool-result limits are stored here too.',
        example: `{
    "tui": {
        "dialogs": {
            "header_style": "box",
            "search_style": "border"
        }
    }
}`,
        documentedIn: 'config-reference',
    },
    {
        name: 'tui.json',
        path: 'tui.json',
        kind: 'file',
        writer: 'both',
        placement: 'home',
        summary: 'Display preferences and keybindings.',
        loads: 'Read by the terminal UI.',
        detail: 'Maps supported action IDs to key combinations, and holds the model picker view, initial scope, and sort under `model_picker`. An empty list unbinds an action.',
        example: `{
    "keybindings": {
        "open_model_picker": ["shift+tab"],
        "dials.open": ["ctrl+d"]
    }
}`,
        documentedIn: 'config-reference',
    },
    {
        name: 'pool.json',
        path: 'pool.json',
        kind: 'file',
        writer: 'vera',
        placement: 'home',
        summary: 'Saved model catalog data.',
        loads: 'Read when models are listed and chosen.',
        detail: 'Holds what provider catalogs returned. Discovery does not select, favorite, verify, or assign a model. Manage it from Switch model and Configure providers.',
        documentedIn: 'config-reference',
    },
    {
        name: 'preferences.json',
        path: 'preferences.json',
        kind: 'file',
        writer: 'vera',
        placement: 'home',
        summary: 'Saved permission answers.',
        loads: 'Read when a tool call needs permission.',
        detail: 'Written when you save a permission answer. Manage it through Vera rather than by hand.',
        documentedIn: 'config-reference',
    },
    {
        name: 'standing-nudges.json',
        path: 'standing-nudges.json',
        kind: 'file',
        writer: 'vera',
        placement: 'home',
        summary: 'Standing preferences managed through `/nudges`.',
        loads: 'Matching rules apply on the next user turn.',
        detail: 'Created on the first save in `/nudges`. A rule can apply everywhere, to one definition, or to one workspace, every turn or at an interval.',
        documentedIn: 'standing-nudges',
    },
    {
        name: 'extensions.json',
        path: 'extensions.json',
        kind: 'file',
        writer: 'vera',
        placement: 'home',
        summary: 'Registry of installed extensions.',
        loads: 'Read when extensions load.',
        detail: 'Written when you install, enable, disable, or remove an extension in `/extensions`.',
        documentedIn: 'config-reference',
    },
    {
        name: 'tips.json',
        path: 'tips.json',
        kind: 'file',
        writer: 'vera',
        placement: 'home',
        summary: 'Tips already shown.',
        loads: 'Read by the terminal UI.',
        detail: 'Keeps Vera from showing the same tip twice.',
        documentedIn: 'config-reference',
    },
    {
        name: 'agents/',
        path: 'agents/',
        kind: 'directory',
        writer: 'both',
        placement: 'home',
        summary: 'Reusable agent definitions for every project.',
        loads: 'Listed when you choose a definition with `/agent` or delegate work.',
        detail: 'Write a definition by hand, or have `/create-agent` save one here when you ask for reuse across projects. A definition sets instructions and a tool list. It can narrow permissions but never widen them.',
        documentedIn: 'config-reference',
    },
    {
        name: 'skills/',
        path: 'skills/',
        kind: 'directory',
        writer: 'you',
        placement: 'home',
        summary: 'Installed skills, one directory each with a `SKILL.md`.',
        loads: 'Allowed skills appear as slash commands. A skill loads when you invoke it or, unless disabled, when the model does.',
        detail: 'A project skill with the same name wins over a home skill.',
        example: `---
name: deploy
description: Deploy the current service.
disable-model-invocation: true
---`,
        documentedIn: 'config-reference',
    },
    {
        name: 'extensions/',
        path: 'extensions/',
        kind: 'directory',
        writer: 'vera',
        placement: 'home',
        summary: 'Installed extensions.',
        loads: 'The TUI side of an extension reloads when a change lands. The host side loads when the host restarts.',
        detail: '`/extension install <path>` copies an extension here. Remove deletes the managed copy and leaves the source untouched.',
        documentedIn: 'config-reference',
    },
    {
        name: 'hooks/',
        path: 'hooks/',
        kind: 'directory',
        writer: 'you',
        placement: 'home',
        summary: 'Executables for command hooks.',
        loads: 'Run only when a hook in `config.json` names them.',
        detail: 'Command hooks run configured executables before or after tool calls, or at session start. With no hooks configured, nothing runs.',
        documentedIn: 'llms.txt',
    },
    {
        name: 'memory/',
        path: 'memory/',
        kind: 'directory',
        writer: 'vera',
        placement: 'home',
        summary: 'Existing memory files. Loading and writing are disabled.',
        loads: 'Never loaded into requests.',
        detail: 'Existing files may appear in `/customize` under Memory. Vera does not recall them into new requests.',
        documentedIn: 'config-reference',
    },
    {
        name: 'machine/',
        path: 'machine/',
        kind: 'directory',
        writer: 'vera',
        placement: 'home',
        summary: 'Credentials and live process records.',
        loads: 'Read by the host and by `vera prune` and `vera doctor`.',
        detail: 'Not for hand-editing.',
        documentedIn: 'config-reference',
        children: [
            {
                name: 'auth.json',
                path: 'machine/auth.json',
                kind: 'file',
                writer: 'vera',
                placement: 'home',
                summary: 'Saved subscription authentication.',
                loads: 'Read when a provider connection signs in.',
                detail: 'Manage it through the provider screen.',
                documentedIn: 'first-run-setup',
            },
            {
                name: 'live/',
                path: 'machine/live/',
                kind: 'directory',
                writer: 'vera',
                placement: 'home',
                summary: 'Registrations of running Vera processes.',
                loads: 'Read by `vera prune`.',
                detail: 'Hosts, clients, workers, watchdogs, supervisors, and the local helper register here. Shell commands and tool subprocesses do not.',
                documentedIn: 'runtime-and-worktrees',
            },
        ],
    },
    {
        name: 'runtime/',
        path: 'runtime/',
        kind: 'directory',
        writer: 'vera',
        placement: 'home',
        summary: 'Host socket, databases, and caches.',
        loads: 'Owned by one resident host at a time.',
        detail: 'Clients attached to the host share its live conversations.',
        documentedIn: 'config-reference',
        children: [
            {
                name: 'sessions/',
                path: 'runtime/sessions/',
                kind: 'directory',
                writer: 'vera',
                placement: 'home',
                summary: 'Saved conversation files.',
                loads: 'Read by `/resume` and `vera -c`.',
                detail: 'Replacing the host keeps conversation identity. `vera export` and `vera inspect` read these files.',
                documentedIn: 'sessions',
            },
            {
                name: 'logs/',
                path: 'runtime/logs/',
                kind: 'directory',
                writer: 'vera',
                placement: 'home',
                summary: 'Diagnostic logs.',
                loads: 'Written while the host runs.',
                detail: 'Treat logs as sensitive local data.',
                documentedIn: 'config-reference',
                children: [
                    {
                        name: 'host.jsonl',
                        path: 'runtime/logs/host.jsonl',
                        kind: 'file',
                        writer: 'vera',
                        placement: 'home',
                        summary: 'The host log.',
                        loads: 'Written while the host runs.',
                        detail: 'Extension startup failures are recorded here.',
                        documentedIn: 'extension-credentials',
                    },
                    {
                        name: 'reviewer.jsonl',
                        path: 'runtime/logs/reviewer.jsonl',
                        kind: 'file',
                        writer: 'vera',
                        placement: 'home',
                        summary: 'One record per permission classifier request.',
                        loads: 'Written when automatic approval asks the classifier.',
                        detail: 'Includes the prompt, response, grades, and latency. It contains conversation material.',
                        documentedIn: 'permission-classifier',
                    },
                ],
            },
        ],
    },
];

const projectNodes: DirectoryNode[] = [
    {
        name: 'AGENTS.md',
        path: 'AGENTS.md',
        kind: 'file',
        writer: 'you',
        placement: 'committed',
        summary: 'Project instructions shared with everyone on the project.',
        loads: 'Read from the project root and included in every request.',
        detail: 'Vera reads it from the project root only. It does not walk parent directories. `/context` lists it under loaded instruction files with its size.',
        documentedIn: 'config-reference',
    },
    {
        name: 'AGENTS.local.md',
        path: 'AGENTS.local.md',
        kind: 'file',
        writer: 'you',
        placement: 'local',
        summary: 'Your own instructions for this project.',
        loads: 'Read from the project root and included in every request.',
        detail: 'Loaded the same way as `AGENTS.md`. Add it to `.gitignore` so it stays on your machine.',
        documentedIn: 'config-reference',
    },
    {
        name: '.vera/',
        path: '.vera/',
        kind: 'directory',
        writer: 'you',
        placement: 'committed',
        summary: 'Project configuration and customization.',
        loads: 'Read when Vera works in this project.',
        detail: 'Project files you can commit so everyone working on the project gets the same setup.',
        documentedIn: 'config-reference',
        children: [
            {
                name: 'config.json',
                path: '.vera/config.json',
                kind: 'file',
                writer: 'you',
                placement: 'committed',
                summary: 'Project configuration.',
                loads: 'Read when Vera works in this project.',
                detail: 'Appears in `/configure` as Project config when it exists. Choosing it there does not create it.',
                documentedIn: 'configuration-files',
            },
            {
                name: 'agents/',
                path: '.vera/agents/',
                kind: 'directory',
                writer: 'both',
                placement: 'committed',
                summary: 'Agent definitions for this project.',
                loads: 'Listed when you choose a definition with `/agent` or delegate work.',
                detail: '`/create-agent` proposes project scope unless you ask for reuse across projects.',
                example: `---
description: Finds concrete defects in a code change
tools:
  - read
  - grep
posture: readonly
---`,
                documentedIn: 'embedded-sdk-reviewer',
            },
            {
                name: 'skills/',
                path: '.vera/skills/',
                kind: 'directory',
                writer: 'you',
                placement: 'committed',
                summary: 'Skills for this project.',
                loads: 'Allowed skills appear as slash commands.',
                detail: 'A project skill wins over a home skill with the same name.',
                documentedIn: 'config-reference',
            },
            {
                name: 'context-routes.yaml',
                path: '.vera/context-routes.yaml',
                kind: 'file',
                writer: 'you',
                placement: 'committed',
                summary: 'Routes from file patterns to instructions.',
                loads: 'Checked after each successful file read.',
                detail: 'When Vera reads a matching file, the named payload joins the next request in that turn. Each payload loads at most once until the conversation compacts.',
                example: `version: 1
routes:
  - trigger:
      read: src/api/**
    consequence:
      inject: context-routes/api.md`,
                documentedIn: 'context-routes',
            },
            {
                name: 'context-routes/',
                path: '.vera/context-routes/',
                kind: 'directory',
                writer: 'you',
                placement: 'committed',
                summary: 'Instruction files that routes load.',
                loads: 'A file loads when a route that names it fires.',
                detail: 'Payload paths are relative to `.vera/` and must stay inside this directory.',
                documentedIn: 'config-reference',
            },
        ],
    },
];

export const directoryTrees: DirectoryTree[] = [
    {
        name: 'home',
        label: 'Home',
        root: '~/.vera',
        intro: 'Settings, installed extensions, and saved data. `VERA_HOME` relocates the whole tree.',
        nodes: homeNodes,
    },
    {
        name: 'project',
        label: 'Project',
        root: 'your-project',
        intro: 'Instructions and customization for one project, kept with the project.',
        nodes: projectNodes,
    },
];
