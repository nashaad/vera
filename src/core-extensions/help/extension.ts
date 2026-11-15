import type { VeraExtensionApi } from "../../sdk/extensions.ts";
import { findShowTarget } from "../../help/show-targets.ts";
import { readExtensionFailures, readProviders } from "./checks.ts";
import { findGuideSection, loadGuideSections, readGuidePage } from "./guide.ts";
import { describeShowOutcome } from "./show.ts";
import * as words from "./words.ts";

const AGENT = "help";
const STORAGE_READ = "extension.storage.read";
const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;

export function activate(vera: VeraExtensionApi): void {
    vera.agents.register({
        name: AGENT,
        description: words.HELP_DESCRIPTION,
        instructions: words.HELP_INSTRUCTIONS,
        tools: ["help_guide", "help_providers", "help_extension_failures", "help_show"],
        skills: [],
    });

    vera.tools.register({
        name: "help_guide",
        description: words.GUIDE_DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                section: { type: "string", description: words.GUIDE_SECTION_FIELD },
                offset: { type: "integer", minimum: 0, description: words.GUIDE_OFFSET_FIELD },
            },
            additionalProperties: false,
        },
        agents: [AGENT],
        permissionOperation: STORAGE_READ,
        parallel: true,
        run({ input }) {
            const { section, offset = 0 } = input;
            if (section !== undefined && typeof section !== "string") return fail(words.GUIDE_BAD_SECTION);
            if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return fail(words.GUIDE_BAD_OFFSET);
            let sections;
            try {
                sections = loadGuideSections();
            } catch {
                return fail(words.GUIDE_UNAVAILABLE);
            }
            if (section === undefined) {
                return { output: words.guideList(sections.map((entry) => ({ name: entry.name, characters: entry.text.length }))) };
            }
            const found = findGuideSection(sections, section);
            if (found.kind === "missing") return fail(words.guideUnknownSection(section, sections.map((entry) => entry.name)));
            if (found.kind === "ambiguous") return fail(words.guideAmbiguousSection(section, found.names));
            const page = readGuidePage(found.section, offset);
            if (offset > 0 && offset >= page.total) return fail(words.guidePastEnd(offset, page.total));
            return {
                output: page.next === undefined ? page.text : `${page.text}\n${words.guideNextPage(page.next, page.total)}`,
            };
        },
    });

    vera.tools.register({
        name: "help_providers",
        description: words.PROVIDERS_DESCRIPTION,
        inputSchema: NO_INPUT,
        agents: [AGENT],
        permissionOperation: STORAGE_READ,
        timeoutMs: 15_000,
        async run() {
            try {
                return { output: await readProviders() };
            } catch {
                return fail(words.PROVIDERS_UNAVAILABLE);
            }
        },
    });

    vera.tools.register({
        name: "help_extension_failures",
        description: words.FAILURES_DESCRIPTION,
        inputSchema: NO_INPUT,
        agents: [AGENT],
        permissionOperation: STORAGE_READ,
        async run() {
            try {
                return { output: await readExtensionFailures() };
            } catch {
                return fail(words.FAILURES_UNAVAILABLE);
            }
        },
    });

    vera.tools.register({
        name: "help_show",
        description: words.showDescription(),
        inputSchema: {
            type: "object",
            properties: { target: { type: "string", description: words.SHOW_TARGET_FIELD } },
            required: ["target"],
            additionalProperties: false,
        },
        agents: [AGENT],
        permissionOperation: STORAGE_READ,
        async run({ input, sessionId }) {
            const target = findShowTarget(input.target);
            if (target === undefined) return fail(words.showUnknownTarget(String(input.target).slice(0, 100)));
            if (sessionId === undefined) return fail(words.SHOW_NEEDS_CHAT);
            try {
                return { output: describeShowOutcome(target, await vera.sessions.show(sessionId, target.id)) };
            } catch {
                return fail(words.SHOW_UNAVAILABLE);
            }
        },
    });
}

function fail(output: string): { readonly output: string; readonly isError: true } {
    return { output, isError: true };
}
