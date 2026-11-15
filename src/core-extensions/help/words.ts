// Everything the model reads from the Help agent: its description, instructions, tool descriptions and tool results.

import { listShowTargets } from "./show.ts";

export const HELP_DESCRIPTION = "Answers questions about using Vera from its product guide and shows where things are.";

export const HELP_INSTRUCTIONS = `You answer questions about using Vera. Answer from the product guide, read with help_guide, and never from memory.

Start with the sections "How to answer" and "Keep the user in the loop", then read the one section they point to. Read the next page of a section only when the first page does not hold the answer.

When the person asks where something is, call help_show with the matching target, then say in one line what opened. When help_show reports that nothing opened, tell the person where to find it in words.

When something may be broken, run help_providers or help_extension_failures once and report what it said.

You cannot change settings, answer dialogs or read files. When the guide does not cover the question, say so and name the nearest thing it does cover.`;

export const GUIDE_DESCRIPTION = "Read the Vera product guide. With no section, lists the sections. With a section, returns that section one page at a time; pass offset to read the next page.";
export const GUIDE_SECTION_FIELD = "A section name from the list, such as \"Models and providers\".";
export const GUIDE_OFFSET_FIELD = "Character offset to continue from, as given at the end of the previous page. Defaults to 0.";

export const PROVIDERS_DESCRIPTION = "List the model providers and whether each is connected. Read-only. Never returns keys.";
export const FAILURES_DESCRIPTION = "List the extensions that failed to load and the reason for each. Read-only.";

export function showDescription(): string {
    return `Open a screen in the person's Vera window so they can see where something is. It changes nothing and answers no dialog. Targets: ${listShowTargets()}.`;
}
export const SHOW_TARGET_FIELD = "The id of the screen to open.";

export function guideList(rows: readonly { readonly name: string; readonly characters: number }[]): string {
    return [
        "Sections of the Vera product guide:",
        ...rows.map((row) => `- ${row.name} (${row.characters} characters)`),
        "Call help_guide with section set to one of these names to read it. A long section is read a page at a time.",
    ].join("\n");
}

export function guideNextPage(end: number, total: number): string {
    return `[Page ends at character ${end} of ${total}. Call help_guide again with offset ${end} for the next page.]`;
}

export const GUIDE_BAD_SECTION = "Section must be a section name from the list.";
export const GUIDE_BAD_OFFSET = "Offset must be a whole number of characters, 0 or more.";
export const GUIDE_UNAVAILABLE = "The product guide is not available.";
export function guideUnknownSection(name: string, names: readonly string[]): string {
    return `No guide section is named "${name}". Sections: ${names.join("; ")}.`;
}
export function guideAmbiguousSection(name: string, names: readonly string[]): string {
    return `"${name}" matches more than one section: ${names.join("; ")}. Use the full name.`;
}
export function guidePastEnd(offset: number, total: number): string {
    return `Offset ${offset} is past the end of this section, which is ${total} characters.`;
}

export const PROVIDERS_UNAVAILABLE = "Vera could not list providers just now.";
export const FAILURES_UNAVAILABLE = "Vera could not read the extension status just now.";

export const SHOW_NEEDS_CHAT = "A screen can be shown only from inside a chat.";
export function showUnknownTarget(target: string): string {
    return `No screen has the target "${target}". Use one of the targets in the tool description.`;
}
export const SHOW_UNAVAILABLE = "Vera could not ask for that screen just now.";
