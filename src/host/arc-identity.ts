import { homedir } from "node:os";
import { join } from "node:path";
import { readRegularFileTextSync } from "../store/regular-file.ts";

const NODE_ID_LINE = /^\s*node_id\s*=\s*"([^"]*)"\s*(?:#.*)?$/;
const TOKEN_LINE = /^\s*token\s*=\s*"([^"]*)"\s*(?:#.*)?$/;

export function defaultArcConfigPath(): string {
    const override = process.env.ARC_CONFIG;
    if (override !== undefined && override !== "") {
        return override;
    }
    return join(homedir(), ".config", "arc", "config.toml");
}

export function readArcNodeId(
    configPath: string = defaultArcConfigPath(),
): string | null {
    return readQuotedValue(configPath, NODE_ID_LINE);
}

export function readArcToken(
    configPath: string = defaultArcConfigPath(),
): string | null {
    return readQuotedValue(configPath, TOKEN_LINE);
}

function readQuotedValue(configPath: string, line: RegExp): string | null {
    let text: string;
    try {
        text = readRegularFileTextSync(configPath);
    } catch {
        return null;
    }
    for (const candidate of text.split("\n")) {
        const match = line.exec(candidate);
        if (match !== null && match[1] !== "") {
            return match[1]!;
        }
    }
    return null;
}
