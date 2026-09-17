import type { CustomizationSource, SourceCategory } from "../../src/customize/types.ts";
import type { VeraClientContextSnapshot } from "../../src/sdk/context.ts";

export const CATEGORIES: readonly { id: SourceCategory; name: string }[] = [
    { id: "agents", name: "Agents" },
    { id: "skills", name: "Skills" },
    { id: "instructions", name: "Instructions" },
    { id: "memory", name: "Memory" },
    { id: "extensions", name: "Extensions" },
];

export function sourceWasLoaded(source: CustomizationSource, context: VeraClientContextSnapshot): boolean {
    const ids = new Set(context.projection?.components.flatMap((item) => item.parts?.map((part) => part.id) ?? []) ?? []);
    return source.contextIds.some((id) => ids.has(id));
}

export function sourceStatus(source: CustomizationSource, context: VeraClientContextSnapshot): string {
    if (source.status === "unreadable") return "source unavailable";
    if (source.category === "skills" && source.status === "disabled") return "disabled by disabled_skills";
    if (sourceWasLoaded(source, context)) return "loaded in last measured request";
    if (source.category === "skills") return "available; individual loading not measured";
    if (source.category === "extensions") return source.status ?? "available";
    if (context.availability === "unavailable") return "available; no measured request";
    return source.status === "memory loading disabled" ? source.status : "available; not in last measured request";
}

export function filterSources(sources: readonly CustomizationSource[], query: string, category?: SourceCategory): readonly CustomizationSource[] {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return sources.filter((source) => (category === undefined || source.category === category)
        && terms.every((term) => `${source.name} ${source.description} ${source.scope} ${source.path ?? ""}`.toLocaleLowerCase().includes(term)));
}
