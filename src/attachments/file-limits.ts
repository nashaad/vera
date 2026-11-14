export const FILE_COUNT_LIMIT = 8;
export const FILE_SIZE_LIMIT = 20 * 1024 * 1024;

export function fileReferences(paths: readonly string[]): string {
    return `Attached files:\n${paths.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`;
}
