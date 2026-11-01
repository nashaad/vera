import { defaultHostLockPath } from "../../../src/host/lockfile.ts";
import { readStampedRelease } from "../../../src/release/stamp.ts";
import {
    recoverInterruptedUpgrade,
    upgradeLocalInstall,
} from "../../../src/release/upgrade.ts";

const [mode, prefix, releaseRoot] = Bun.argv.slice(2);
const fixtureRoot = process.env.VERA_FIXTURE_ROOT;

if (
    fixtureRoot === undefined
    || mode === undefined
    || prefix === undefined
    || releaseRoot === undefined
    || !defaultHostLockPath().startsWith(`${fixtureRoot}/`)
) {
    process.stderr.write(
        `run-default-upgrade: the host lock ${defaultHostLockPath()} is outside the fixture root\n`,
    );
    process.exit(3);
}

try {
    if (mode === "recover") {
        const recovered = await recoverInterruptedUpgrade({ prefix });
        process.stdout.write(`${JSON.stringify(recovered)}\n`);
    } else {
        const upgraded = await upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot,
                manifest: readStampedRelease(releaseRoot),
            }),
            verify: () => undefined,
        });
        process.stdout.write(`${JSON.stringify({
            buildId: upgraded.manifest.build_id,
            fromBuildId: upgraded.fromBuildId,
        })}\n`);
    }
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}
