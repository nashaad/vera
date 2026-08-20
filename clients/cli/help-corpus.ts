export interface HelpTopic {
    readonly slug: string;
    readonly title: string;
    readonly aliases: readonly string[];
    readonly body: string;
    readonly summary: string;
}

export interface HelpCorpus {
    readonly title: string;
    readonly intro: string;
    readonly topics: readonly HelpTopic[];
}

export interface HelpRequest {
    readonly topic?: string;
    readonly llms: boolean;
}

const HELP_SOURCE_URL = new URL("../../src/help/index.md", import.meta.url);

export async function loadHelpCorpus(): Promise<HelpCorpus> {
    return parseHelpCorpus(await Bun.file(HELP_SOURCE_URL).text());
}

export function parseHelpCorpus(markdown: string): HelpCorpus {
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    let title: string | undefined;
    const introLines: string[] = [];
    const drafts: TopicDraft[] = [];
    let current: TopicDraft | undefined;

    for (const line of lines) {
        const titleMatch = /^# (.+)$/.exec(line);
        if (titleMatch !== null && title === undefined && current === undefined) {
            title = titleMatch[1];
            continue;
        }

        const topicMatch = /^## (.+)$/.exec(line);
        if (topicMatch !== null) {
            current = {
                header: topicMatch[1]!,
                lines: [],
            };
            drafts.push(current);
            continue;
        }

        if (current === undefined) {
            introLines.push(line);
        } else {
            current.lines.push(line);
        }
    }

    if (title === undefined || title.trim().length === 0) {
        throw new Error("Vera help source must have a top-level title");
    }
    if (drafts.length === 0) {
        throw new Error("Vera help source must define at least one topic");
    }

    const topics = drafts.map(parseTopic);
    assertUniqueKeys(topics);
    return {
        title: title.trim(),
        intro: cleanBlock(introLines),
        topics,
    };
}

export function parseHelpRequest(args: readonly string[]): HelpRequest | undefined {
    if (args[0] !== "help") return undefined;
    if (args.length === 1) return { llms: false };
    if (args.length === 2 && args[1] === "--llms") return { llms: true };
    if (
        args.length === 2
        && typeof args[1] === "string"
        && args[1].length > 0
        && !args[1].startsWith("-")
    ) {
        return { topic: args[1], llms: false };
    }
    return undefined;
}

export function findHelpTopic(
    corpus: HelpCorpus,
    requested: string,
): HelpTopic | undefined {
    const key = normalizeHelpKey(requested);
    return corpus.topics.find((topic) =>
        topic.slug === key || topic.aliases.includes(key)
    );
}

export function renderHelpIndex(corpus: HelpCorpus): string {
    const width = Math.max(...corpus.topics.map((topic) => topic.slug.length));
    const topics = corpus.topics.map((topic) =>
        `  ${topic.slug.padEnd(width)}  ${topic.summary}`
    );
    return [
        corpus.title,
        "",
        corpus.intro,
        "",
        "Topics:",
        ...topics,
        "",
        "Use `vera help <topic>` for one topic, or `vera help --llms` for the",
        "compact help corpus.",
        "",
    ].join("\n");
}

export function renderHelpTopic(topic: HelpTopic): string {
    return [
        `${topic.title} (${topic.slug})`,
        "",
        topic.body,
        "",
    ].join("\n");
}

export function renderLlmHelp(corpus: HelpCorpus): string {
    const lines = [
        `# ${corpus.title}`,
        "",
        corpus.intro,
        "",
        "## Topics",
        ...corpus.topics.map((topic) =>
            `- ${topic.slug}: ${topic.summary}`
        ),
        "",
    ];

    for (const topic of corpus.topics) {
        lines.push(`## ${topic.slug} — ${topic.title}`);
        if (topic.aliases.length > 0) {
            lines.push(`Aliases: ${topic.aliases.join(", ")}`);
        }
        lines.push("", topic.body, "");
    }

    return `${lines.join("\n").trimEnd()}\n`;
}

export function renderHelpUsage(): string {
    return "Usage: vera help [topic]\n       vera help --llms\n";
}

interface TopicDraft {
    readonly header: string;
    readonly lines: string[];
}

function parseTopic(draft: TopicDraft): HelpTopic {
    const separator = draft.header.indexOf(" — ");
    const slugPart = separator === -1
        ? draft.header
        : draft.header.slice(0, separator);
    const titlePart = separator === -1
        ? draft.header
        : draft.header.slice(separator + 3);
    const lines = [...draft.lines];
    const aliasesIndex = lines.findIndex((line) => line.startsWith("Aliases:"));
    const aliases = aliasesIndex === -1
        ? []
        : (lines[aliasesIndex]!.match(/`([^`]+)`/g) ?? [])
            .map((alias) => normalizeHelpKey(alias.slice(1, -1)));
    if (aliasesIndex !== -1) lines.splice(aliasesIndex, 1);

    const slug = normalizeHelpKey(slugPart);
    const title = titlePart.trim();
    const body = cleanBlock(lines);
    if (slug.length === 0 || title.length === 0 || body.length === 0) {
        throw new Error(`Vera help topic is incomplete: ${draft.header}`);
    }

    return {
        slug,
        title,
        aliases,
        body,
        summary: firstParagraph(body),
    };
}

function assertUniqueKeys(topics: readonly HelpTopic[]): void {
    const seen = new Set<string>();
    for (const topic of topics) {
        for (const key of [topic.slug, ...topic.aliases]) {
            if (seen.has(key)) throw new Error(`Duplicate Vera help key: ${key}`);
            seen.add(key);
        }
    }
}

function normalizeHelpKey(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function cleanBlock(lines: readonly string[]): string {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start]!.trim().length === 0) start += 1;
    while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
    return lines.slice(start, end).join("\n");
}

function firstParagraph(body: string): string {
    return body.split("\n").find((line) => line.trim().length > 0)!.trim();
}
