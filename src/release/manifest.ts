export const RELEASE_LAYOUT_VERSION = 1;
export const VERA_PRODUCT_VERSION = "0.0.4";

export const RELEASE_ARTIFACT_NAMES = [
    "cli",
    "tui",
    "host",
    "worker",
    "annex",
    "annex_assets",
    "builtins",
] as const;

export type ReleaseArtifactName = (typeof RELEASE_ARTIFACT_NAMES)[number];

export interface ReleaseManifest {
    readonly layout_version: number;
    readonly product_version: string;
    readonly source_revision: string;
    readonly build_id: string;
    readonly protocol_version: number;
    readonly platform: string;
    readonly arch: string;
    readonly asset_digest: string;
    readonly built_at: string;
    readonly artifacts: readonly ReleaseArtifactName[];
}

const ARTIFACT_SET = new Set<string>(RELEASE_ARTIFACT_NAMES);

function fail(field: string, detail: string): never {
    throw new Error(`Release manifest ${field}: ${detail}`);
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        fail(field, "must be a non-empty string");
    }
    return value;
}

function requiredNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        fail(field, "must be an integer");
    }
    return value;
}

function parseArtifacts(value: unknown): readonly ReleaseArtifactName[] {
    if (!Array.isArray(value) || value.length === 0) {
        fail("artifacts", "must be a non-empty array");
    }
    const artifacts: ReleaseArtifactName[] = [];
    for (const item of value) {
        if (typeof item !== "string" || !ARTIFACT_SET.has(item)) {
            fail("artifacts", `unknown artifact ${String(item)}`);
        }
        artifacts.push(item as ReleaseArtifactName);
    }
    if (!artifacts.includes("annex")) {
        fail("artifacts", "must include annex");
    }
    if (!artifacts.includes("annex_assets")) {
        fail("artifacts", "must include annex_assets");
    }
    return artifacts;
}

export function serializeReleaseManifest(manifest: ReleaseManifest): string {
    return `${JSON.stringify({
        layout_version: manifest.layout_version,
        product_version: manifest.product_version,
        source_revision: manifest.source_revision,
        build_id: manifest.build_id,
        protocol_version: manifest.protocol_version,
        platform: manifest.platform,
        arch: manifest.arch,
        asset_digest: manifest.asset_digest,
        built_at: manifest.built_at,
        artifacts: [...manifest.artifacts],
    }, null, 2)}\n`;
}

export function parseReleaseManifest(text: string): ReleaseManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Release manifest is not JSON: ${reason}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail("root", "must be an object");
    }
    const record = parsed as Record<string, unknown>;
    const layoutVersion = requiredNumber(record.layout_version, "layout_version");
    if (layoutVersion !== RELEASE_LAYOUT_VERSION) {
        fail(
            "layout_version",
            `unsupported ${layoutVersion}, expected ${RELEASE_LAYOUT_VERSION}`,
        );
    }
    const assetDigest = requiredString(record.asset_digest, "asset_digest");
    if (!assetDigest.startsWith("sha256:")) {
        fail("asset_digest", "must be a sha256 digest");
    }
    return {
        layout_version: layoutVersion,
        product_version: requiredString(record.product_version, "product_version"),
        source_revision: requiredString(record.source_revision, "source_revision"),
        build_id: requiredString(record.build_id, "build_id"),
        protocol_version: requiredNumber(
            record.protocol_version,
            "protocol_version",
        ),
        platform: requiredString(record.platform, "platform"),
        arch: requiredString(record.arch, "arch"),
        asset_digest: assetDigest,
        built_at: requiredString(record.built_at, "built_at"),
        artifacts: parseArtifacts(record.artifacts),
    };
}
