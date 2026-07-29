import { createHash } from "node:crypto";
import type { ModelTool } from "../model/types.ts";
import type { ProjectInstructionSnapshot } from "./project-instructions.ts";

export type PromptContributionTarget = "stable" | "contextual";

export interface PromptContribution {
    readonly id: string;
    readonly owner: "core";
    readonly target: PromptContributionTarget;
    readonly title: string;
    readonly content: string;
}

export interface PromptContributionMetadata {
    readonly id: string;
    readonly owner: "core";
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
    readonly disabledContributions?: readonly string[];
}

export interface StablePromptContributionInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly disabledContributions?: readonly string[];
}

export interface ContextualPromptContributionInput {
    readonly date: Date;
    readonly projectInstructions?: ProjectInstructionSnapshot;
    readonly disabledContributions?: readonly string[];
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
        id: "core.tools",
        owner: "core",
        target: "stable",
        contribute: (input) => ({
            title: "Tools",
            content: renderTools(input.tools),
        }),
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
                    + "off as you go, re-read it after compaction.\n"
                    + "The OS deletes this directory; keep nothing you need "
                    + "later.",
            },
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
];

export function collectBuiltInPromptContributions(
    input: PromptContributionInput,
): readonly PromptContribution[] {
    return [
        ...collectStablePromptContributions(input),
        ...collectContextualPromptContributions(input),
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
    return BUILT_IN_PROMPT_CONTRIBUTORS.flatMap((contributor) =>
        contributor.target === "stable"
            && !isDisabled(contributor.id, input.disabledContributions)
            ? collectContribution(contributor, contributor.contribute(input))
            : []
    );
}

export function collectContextualPromptContributions(
    input: ContextualPromptContributionInput,
): readonly PromptContribution[] {
    return BUILT_IN_PROMPT_CONTRIBUTORS.flatMap((contributor) =>
        contributor.target === "contextual"
            && !isDisabled(contributor.id, input.disabledContributions)
            ? collectContribution(contributor, contributor.contribute(input))
            : []
    );
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
