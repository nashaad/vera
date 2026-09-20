import { createHash } from "node:crypto";
import type { ModelTool } from "../model/types.ts";
import type { MemorySnapshot } from "./memory.ts";
import type { ProjectInstructionSnapshot } from "./project-instructions.ts";
import type { ScratchStateSnapshot } from "./scratch-state.ts";

export type PromptContributionTarget = "stable" | "contextual";

export interface PromptContribution {
    readonly id: string;
    readonly owner: string;
    readonly target: PromptContributionTarget;
    readonly title: string;
    readonly content: string;
}

export interface ContextualContributionContext {
    readonly sessionId?: string;
    readonly turn: "user" | "delivery";
    readonly workspace: string;
    readonly agent: string;
}

export interface PromptContributionMetadata {
    readonly id: string;
    readonly owner: string;
    readonly target: PromptContributionTarget;
    readonly order: number;
    readonly bytes: number;
    readonly sha256: string;
}

export interface PromptContributionInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly date: Date;
    readonly projectInstructions?: ProjectInstructionSnapshot;
    readonly memory?: MemorySnapshot;
    readonly scratchState?: ScratchStateSnapshot;
    readonly disabledContributions?: readonly string[];
    /**
     * Which contributions render, and in what order. Absent uses the built-in
     * order. Every built-in contribution must be named exactly once.
     */
    readonly contributionOrder?: readonly string[];
    readonly additionalContextualContributions?: readonly PromptContribution[];
    readonly agentInstructions?: string;
}

export interface StablePromptContributionInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly disabledContributions?: readonly string[];
    /**
     * Which contributions render, and in what order. Absent uses the built-in
     * order. Every built-in contribution must be named exactly once.
     */
    readonly contributionOrder?: readonly string[];
    readonly agentInstructions?: string;
}

export interface ContextualPromptContributionInput {
    readonly date: Date;
    readonly projectInstructions?: ProjectInstructionSnapshot;
    readonly memory?: MemorySnapshot;
    readonly scratchState?: ScratchStateSnapshot;
    readonly disabledContributions?: readonly string[];
    /**
     * Which contributions render, and in what order. Absent uses the built-in
     * order. Every built-in contribution must be named exactly once.
     */
    readonly contributionOrder?: readonly string[];
    readonly additionalContributions?: readonly PromptContribution[];
}

interface StablePromptContributor {
    readonly id: string;
    readonly owner: "core";
    readonly target: "stable";
    readonly contribute: (
        input: StablePromptContributionInput,
    ) => Omit<PromptContribution, "id" | "owner" | "target"> | null;
}

interface ContextualPromptContributor {
    readonly id: string;
    readonly owner: "core";
    readonly target: "contextual";
    readonly contribute: (
        input: ContextualPromptContributionInput,
    ) => Omit<PromptContribution, "id" | "owner" | "target"> | null;
}

type BuiltInPromptContributor =
    | StablePromptContributor
    | ContextualPromptContributor;

const BUILT_IN_PROMPT_CONTRIBUTORS: readonly BuiltInPromptContributor[] = [
    {
        id: "core.identity",
        owner: "core",
        target: "stable",
        contribute: () => ({
            title: "Identity",
            content: "You are Vera, a coding agent. Follow the user's instructions and use the available tools when they help.",
        }),
    },
    {
        id: "core.narration",
        owner: "core",
        target: "stable",
        contribute: () => ({
            title: "Narration",
            content:
                "Say what you are doing as you go. Before your first tool "
                + "call, state in one sentence what you are about to do. "
                + "While working, post a short update when you find "
                + "something, change direction, or hit a blocker. Write these "
                + "as ordinary response text. Reasoning may be hidden from "
                + "the user, so it is not a substitute for telling them what "
                + "is happening.",
        }),
    },
    {
        id: "core.tools",
        owner: "core",
        target: "stable",
        contribute: (input) => ({
            title: "Tools",
            content: renderTools(input.tools),
        }),
    },
    {
        id: "core.subagents",
        owner: "core",
        target: "stable",
        contribute: (input) =>
            input.tools.some((tool) => tool.name === "subagent") ? {
                title: "Subagents",
                content:
                    "Use the subagent tool when a task benefits from it: "
                    + "parallelizing independent queries, or protecting your "
                    + "context window from large intermediate results. Do not "
                    + "spawn subagents when direct work is simpler, and do not "
                    + "duplicate work you have delegated (if a subagent is "
                    + "researching something, do not run the same searches "
                    + "yourself).",
            } : null,
    },
    {
        id: "core.workspace",
        owner: "core",
        target: "stable",
        contribute: (input) => ({
            title: "Workspace",
            content: `Working directory: ${input.workspace}`,
        }),
    },
    {
        id: "core.scratchpad",
        owner: "core",
        target: "stable",
        contribute: (input) =>
            input.scratchDir === undefined ? null : {
                title: "Scratch directory",
                content: `Disposable per-session scratch directory: ${input.scratchDir}\n`
                    + "Use it freely (writes here need no approval) instead "
                    + "of /tmp for temporary files and working notes.\n"
                    + "For tasks with more than a couple of steps, keep your "
                    + "todo list as todo.md here (the file is the list, chat "
                    + "is optional): create it when you start, check items "
                    + "off and strike them through as you go, re-read it "
                    + "after compaction.\n"
                    + "The OS deletes this directory; keep nothing you need "
                    + "later.",
            },
    },
    {
        id: "core.agent-instructions",
        owner: "core",
        target: "stable",
        contribute: (input) =>
            (input as StablePromptContributionInput).agentInstructions
                    ?.trim()
                    .length
                ? {
                    title: "Agent",
                    content:
                        (input as StablePromptContributionInput)
                            .agentInstructions!.trim(),
                }
                : null,
    },
    {
        id: "core.date",
        owner: "core",
        target: "contextual",
        contribute: (input) => ({
            title: "Date",
            content: `Current date: ${formatLocalDate(input.date)}`,
        }),
    },
    {
        id: "core.scratchpad-state",
        owner: "core",
        target: "contextual",
        contribute: (input) => {
            const state = input.scratchState;
            if (state === undefined) {
                return null;
            }
            const listed = state.truncatedFiles > 0
                ? `${state.files.join(", ")} (+${state.truncatedFiles} more)`
                : state.files.join(", ");
            return {
                title: "Scratch directory state",
                content: `Files: ${listed}`
                    + (state.todo === undefined
                        ? ""
                        : `\ntodo.md:\n${state.todo}`),
            };
        },
    },
    {
        id: "core.project-instructions",
        owner: "core",
        target: "contextual",
        contribute: (input) => {
            const snapshot = input.projectInstructions;
            if (
                snapshot === undefined
                || (snapshot.files.length === 0 && snapshot.warnings.length === 0)
            ) {
                return null;
            }
            return {
                title: "Project instructions",
                content: renderProjectInstructions(snapshot),
            };
        },
    },
    {
        id: "core.memory",
        owner: "core",
        target: "contextual",
        contribute: (input) => {
            const snapshot = input.memory;
            if (
                snapshot === undefined
                || (snapshot.files.length === 0 && snapshot.warnings.length === 0)
            ) {
                return null;
            }
            return {
                title: "Memory",
                content: renderMemory(snapshot),
            };
        },
    },
];

export const DEFAULT_PROMPT_CONTRIBUTION_ORDER: readonly string[] = Object
    .freeze(
        BUILT_IN_PROMPT_CONTRIBUTORS.map((contributor) => contributor.id),
    );

/**
 * The first contribution is pinned: every later one is read against the
 * identity it establishes.
 */
const PINNED_FIRST_CONTRIBUTION = "core.identity";

/**
 * Rejects an order that cannot be rendered as written. A stable contribution
 * is part of the cached prefix and a contextual one is rebuilt each turn, so
 * the two bands render separately whatever the list says; requiring every
 * stable id ahead of every contextual one keeps the list readable as the
 * prompt it produces.
 */
export function validatePromptContributionOrder(
    order: readonly string[],
): void {
    const known = new Map(
        BUILT_IN_PROMPT_CONTRIBUTORS.map((contributor) => [
            contributor.id,
            contributor.target,
        ]),
    );
    const unknown = order.filter((id) => !known.has(id));
    if (unknown.length > 0) {
        throw new Error(
            `Prompt contribution order names contributions that do not exist: ${
                unknown.join(", ")
            }`,
        );
    }
    const seen = new Set<string>();
    const duplicated = order.filter((id) => {
        const repeat = seen.has(id);
        seen.add(id);
        return repeat;
    });
    if (duplicated.length > 0) {
        throw new Error(
            `Prompt contribution order repeats: ${duplicated.join(", ")}`,
        );
    }
    const missing = [...known.keys()].filter((id) => !seen.has(id));
    if (missing.length > 0) {
        throw new Error(
            `Prompt contribution order leaves out: ${
                missing.join(", ")
            }. An order names every contribution; turning one off is separate.`,
        );
    }
    if (order[0] !== PINNED_FIRST_CONTRIBUTION) {
        throw new Error(
            `Prompt contribution order must start with ${PINNED_FIRST_CONTRIBUTION}`,
        );
    }
    const firstContextual = order.findIndex((id) =>
        known.get(id) === "contextual"
    );
    if (firstContextual >= 0) {
        const strayStable = order
            .slice(firstContextual)
            .filter((id) => known.get(id) === "stable");
        if (strayStable.length > 0) {
            throw new Error(
                `Prompt contribution order puts ${
                    strayStable.join(", ")
                } after ${order[firstContextual]}, but every stable contribution renders before every contextual one`,
            );
        }
    }
}

function orderedContributors(
    order: readonly string[] | undefined,
): readonly BuiltInPromptContributor[] {
    if (order === undefined) {
        return BUILT_IN_PROMPT_CONTRIBUTORS;
    }
    validatePromptContributionOrder(order);
    const byId = new Map(
        BUILT_IN_PROMPT_CONTRIBUTORS.map((contributor) => [
            contributor.id,
            contributor,
        ]),
    );
    return order.map((id) => byId.get(id)!);
}

export function collectBuiltInPromptContributions(
    input: PromptContributionInput,
): readonly PromptContribution[] {
    return [
        ...collectStablePromptContributions(input),
        ...collectContextualPromptContributions({
            ...input,
            additionalContributions: input.additionalContextualContributions,
        }),
    ];
}

export function promptContributionMetadata(
    contributions: readonly PromptContribution[],
): readonly PromptContributionMetadata[] {
    return contributions.map(
        (contribution, order) => {
            const rendered = renderPromptContribution(contribution);
            return {
                id: contribution.id,
                owner: contribution.owner,
                target: contribution.target,
                order,
                bytes: Buffer.byteLength(rendered, "utf8"),
                sha256: createHash("sha256")
                    .update(rendered, "utf8")
                    .digest("hex"),
            };
        },
    );
}

export function renderPromptContribution(
    contribution: PromptContribution,
): string {
    return `## ${contribution.title}\n${contribution.content}`;
}

export function collectStablePromptContributions(
    input: StablePromptContributionInput,
): readonly PromptContribution[] {
    return orderedContributors(input.contributionOrder).flatMap((contributor) =>
        contributor.target === "stable"
            && !isDisabled(contributor.id, input.disabledContributions)
            ? collectContribution(contributor, contributor.contribute(input))
            : []
    );
}

export function collectContextualPromptContributions(
    input: ContextualPromptContributionInput,
): readonly PromptContribution[] {
    const builtIn = orderedContributors(input.contributionOrder).flatMap((
        contributor,
    ) =>
        contributor.target === "contextual"
            && !isDisabled(contributor.id, input.disabledContributions)
            ? collectContribution(contributor, contributor.contribute(input))
            : []
    );
    const additional = input.additionalContributions ?? [];
    validateAdditionalContributions(builtIn, additional);
    return [
        ...builtIn,
        ...additional.filter((contribution) =>
            !isDisabled(contribution.id, input.disabledContributions)
        ),
    ];
}

function validateAdditionalContributions(
    builtIn: readonly PromptContribution[],
    additional: readonly PromptContribution[],
): void {
    const ids = new Set(builtIn.map((contribution) => contribution.id));
    for (const contribution of additional) {
        if (
            contribution.id.trim().length === 0
            || contribution.owner.trim().length === 0
            || contribution.title.trim().length === 0
            || contribution.target !== "contextual"
        ) {
            throw new Error("Owner prompt contributions must be attributed contextual text");
        }
        if (ids.has(contribution.id)) {
            throw new Error(`Duplicate prompt contribution id: ${contribution.id}`);
        }
        ids.add(contribution.id);
    }
}

function isDisabled(
    id: string,
    disabled: readonly string[] | undefined,
): boolean {
    return disabled !== undefined && disabled.includes(id);
}

function collectContribution(
    contributor: BuiltInPromptContributor,
    contribution: Omit<PromptContribution, "id" | "owner" | "target"> | null,
): readonly PromptContribution[] {
    return contribution === null
        ? []
        : [{
            id: contributor.id,
            owner: contributor.owner,
            target: contributor.target,
            ...contribution,
        }];
}

function renderTools(tools: readonly ModelTool[]): string {
    const lines = tools.map((tool) => `- ${tool.name}: ${tool.description}`);
    return ["Available tools:", ...(lines.length === 0 ? ["(none)"] : lines)]
        .join("\n");
}

function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function renderMemory(snapshot: MemorySnapshot): string {
    const sections = snapshot.files.map((file) =>
        [
            "Memory index. Each line points to a file under "
                + `\`${file.dir}\`; read a file when its hook is relevant `
                + "to the task.",
            "Memory topic discovery (index metadata; topic bodies are not "
                + "loaded unless listed below):",
            ...file.topics.map((topic) =>
                `- ${topic.availability}: ${topic.file} — ${topic.title ?? "(untitled)"}`
                    + ` — hook: ${topic.hook ?? "(none)"}`
                    + (topic.bytes === undefined ? "" : ` — ${topic.bytes} bytes`)
            ),
            ...(file.topics.length === 0 ? ["(no valid topic entries)"] : []),
            file.content,
        ].join("\n")
    );
    if (snapshot.recommendations.length > 0) {
        sections.push([
            "Memory topics recommended from the current request:",
            ...snapshot.recommendations.map((topic) =>
                `- ${topic.scope}/${topic.file} (${topic.availability})`
            ),
        ].join("\n"));
    }
    if (snapshot.loadedTopics.length > 0) {
        sections.push([
            "Memory topic bodies actually loaded by the engine:",
            ...snapshot.loadedTopics.map((topic) =>
                `### ${topic.scope}/${topic.file}\n${topic.content}`
            ),
        ].join("\n\n"));
    }
    if (snapshot.warnings.length > 0) {
        sections.push([
            "### Loading diagnostics",
            ...snapshot.warnings.map((warning) => `- ${warning}`),
        ].join("\n"));
    }
    return sections.join("\n\n");
}

function renderProjectInstructions(
    snapshot: ProjectInstructionSnapshot,
): string {
    const sections = snapshot.files.map((file) =>
        [`### ${file.name}`, file.content].join("\n")
    );
    if (snapshot.warnings.length > 0) {
        sections.push([
            "### Loading diagnostics",
            ...snapshot.warnings.map((warning) => `- ${warning}`),
        ].join("\n"));
    }
    return sections.join("\n\n");
}
