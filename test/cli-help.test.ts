import { expect, test } from "bun:test";

import { runCli } from "../clients/cli/main.ts";
import {
    parseHelpCorpus,
    parseHelpRequest,
} from "../clients/cli/help-corpus.ts";

const corpus = parseHelpCorpus(`# Vera help

Use a topic for focused guidance.

## profiles — Profiles and configuration

Aliases: \`profile\`, \`config\`

Select a profile when Vera starts.

## recovery — Recovery

When Vera is stuck, preserve state before stopping it.
`);

test("help requests distinguish the index, a topic, and llms output", () => {
    expect(parseHelpRequest(["help"])).toEqual({ llms: false });
    expect(parseHelpRequest(["help", "profiles"])).toEqual({
        topic: "profiles",
        llms: false,
    });
    expect(parseHelpRequest(["help", "--llms"])).toEqual({ llms: true });
    expect(parseHelpRequest(["help", "profiles", "--llms"])).toBeUndefined();
    expect(parseHelpRequest(["doctor"])).toBeUndefined();
});

test("topic summaries keep the complete first paragraph", () => {
    const wrapped = parseHelpCorpus(`# Vera help

Use a topic for focused guidance.

## profiles — Profiles and configuration

Select a profile when Vera starts. The first paragraph can wrap across
source lines without becoming a fragment in the top-level help.
`);

    expect(wrapped.topics[0]?.summary).toBe(
        "Select a profile when Vera starts. The first paragraph can wrap across source lines without becoming a fragment in the top-level help.",
    );
});

test("top-level help aliases render one command and topic overview", async () => {
    const outputs: string[] = [];
    let started = false;
    const dependencies = {
        helpCorpus: async () => corpus,
        runTui: async () => {
            started = true;
        },
        stdout: { write: (text: string) => outputs.push(text) },
    };

    expect(await runCli(["help"], dependencies)).toBe(0);
    expect(await runCli(["--help"], dependencies)).toBe(0);
    expect(await runCli(["-h"], dependencies)).toBe(0);
    expect(outputs[0]).toBe(outputs[1]);
    expect(outputs[1]).toBe(outputs[2]);
    expect(outputs[0]).toContain("Vera coding agent");
    expect(outputs[0]).toContain("vera attach <agent-id>");
    expect(outputs[0]).toContain("Help topics:");
    expect(outputs[0]).toContain("profiles");
    expect(outputs[0]).toContain("recovery");
    expect(started).toBe(false);

    outputs.length = 0;
    expect(await runCli(["help", "profile"], dependencies)).toBe(0);
    expect(outputs[0]).toContain("Profiles and configuration (profiles)");
    expect(outputs[0]).toContain("Select a profile when Vera starts.");
    expect(started).toBe(false);
});

test("vera help --llms renders the same topics in a compact document", async () => {
    let output = "";
    expect(await runCli(["help", "--llms"], {
        helpCorpus: async () => corpus,
        stdout: { write: (text: string) => output += text },
    })).toBe(0);

    expect(output).toContain("# Vera help");
    expect(output).toContain("## Topics");
    expect(output).toContain("## profiles — Profiles and configuration");
    expect(output).toContain("Aliases: profile, config");
    expect(output).toContain("## recovery — Recovery");
});

test("unknown help topics name the available topics", async () => {
    let error = "";
    expect(await runCli(["help", "unknown"], {
        helpCorpus: async () => corpus,
        stderr: { write: (text: string) => error += text },
    })).toBe(1);

    expect(error).toContain("Unknown Vera help topic 'unknown'.");
    expect(error).toContain("profiles, recovery");
    expect(error).toContain("Usage: vera help [topic]");
});
