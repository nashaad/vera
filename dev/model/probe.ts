/**
 * The admission seam the custodian workflow shells out to.
 *
 *     bun run dev/model/probe.ts --provider <provider> --model <id>
 *
 * Provider keys come from the environment only; nothing here reads stored
 * credentials. The probe itself is the same `admitModel` the picker checklist
 * and `pool_add` run, so a published verdict can never disagree with what a
 * local admission would have concluded.
 *
 * Exactly one JSON feed row goes to stdout. A probe failure is still a valid
 * row (exit 0); only a usage error, an unknown provider, or missing
 * credentials exit nonzero, so the caller can tell "this model failed" from
 * "this invocation was wrong".
 */

import type { VeraConfig } from "../../src/config.ts";
import { admitModel } from "../../src/model/admission.ts";
import { effectiveCatalog } from "../../src/model/catalog.ts";
import { feedRowForVerdict } from "../../src/model/feed-shape.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { findProvider } from "../../src/providers/registry.ts";

interface ProbeArgs {
    readonly provider: string;
    readonly model: string;
}

function parseArgs(argv: readonly string[]): ProbeArgs {
    let provider: string | undefined;
    let model: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (flag === "--provider" && value !== undefined) {
            provider = value;
            index += 1;
        } else if (flag === "--model" && value !== undefined) {
            model = value;
            index += 1;
        } else {
            throw new Error(`unrecognized argument: ${flag}`);
        }
    }
    if (provider === undefined || model === undefined) {
        throw new Error(
            "usage: bun run dev/model/probe.ts"
                + " --provider <provider> --model <id>",
        );
    }
    return { provider, model };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (findProvider(args.provider) === undefined) {
        throw new Error(`unknown provider: ${args.provider}`);
    }
    if (args.provider === "openai-codex") {
        // OAuth credentials have no env form; those models stay local-probe
        // only, on the user's own login.
        throw new Error("openai-codex models are not probed centrally");
    }
    // `createConfiguredModelAdapter` reads only `provider` from the config,
    // and with no auth storage passed the key comes from the environment.
    const adapter = createConfiguredModelAdapter(
        { provider: args.provider } as VeraConfig,
        { env: process.env },
    );
    const catalogModel = effectiveCatalog(args.provider)
        .models.find((candidate) => candidate.id === args.model);
    const verdict = await admitModel({
        adapter,
        provider: args.provider,
        model: args.model,
        ...(catalogModel === undefined ? {} : { catalogModel }),
        checked: "vera",
    });
    const row = feedRowForVerdict({
        provider: args.provider,
        model: args.model,
        verdict,
        ...(catalogModel === undefined ? {} : { catalogModel }),
        verifiedAt: new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
}

main().catch((error: unknown) => {
    process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
});
