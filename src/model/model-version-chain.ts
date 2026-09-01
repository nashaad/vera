
const VERSION = /(?<![a-z0-9.])(\d+(?:\.\d+)*)(?![a-z0-9.])/;

export interface VersionChain {
    readonly stem: string;
}

export function versionChain(id: string): VersionChain | undefined {
    const match = VERSION.exec(id);
    if (match === null) {
        return undefined;
    }
    return {
        stem: `${id.slice(0, match.index)}#${id.slice(match.index + match[0].length)}`,
    };
}
