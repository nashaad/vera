/**
 * Which models are successive versions of one another.
 *
 * A chain is the narrow claim that two ids name the same model at different
 * versions: `anthropic/claude-opus-4.8` and `anthropic/claude-opus-5`. It is
 * deliberately narrower than a vendor's marketing family. `qwen3-coder-30b` and
 * `qwen3-32b` share a family and are not a chain, because neither replaces the
 * other, and folding one away would hide a model nothing else offers.
 *
 * The test is mechanical: blank the version out of the id and see whether what
 * is left matches. `claude-opus-#` and `claude-opus-#-fast` are two chains, not
 * one, so the fast variant never stands in for the plain row.
 */

/**
 * The first version-looking run of digits in an id, with the surrounding text
 * kept as the stem. Bounded on both sides so that the `3` in `qwen3-coder` and
 * the `30b` in a size suffix are treated alike: both are part of what the model
 * is, and only a standalone version is a position in a chain.
 */
const VERSION = /(?<![a-z0-9.])(\d+(?:\.\d+)*)(?![a-z0-9.])/;

export interface VersionChain {
    /** The id with its version blanked out, which two versions share. */
    readonly stem: string;
}

/**
 * The chain an id belongs to, or `undefined` when it carries no version and so
 * cannot be a version of anything.
 */
export function versionChain(id: string): VersionChain | undefined {
    const match = VERSION.exec(id);
    if (match === null) {
        return undefined;
    }
    return {
        stem: `${id.slice(0, match.index)}#${id.slice(match.index + match[0].length)}`,
    };
}
