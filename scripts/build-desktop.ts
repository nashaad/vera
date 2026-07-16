import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const appRoot = resolve(projectRoot, "clients/desktop");
const sourceRoot = resolve(appRoot, "src");
const outputRoot = resolve(appRoot, "dist");
const binaryRoot = resolve(appRoot, "src-tauri/binaries");

await mkdir(outputRoot, { recursive: true });
await mkdir(binaryRoot, { recursive: true });

const frontend = await Bun.build({
    entrypoints: [resolve(sourceRoot, "main.ts")],
    outdir: outputRoot,
    target: "browser",
    minify: true,
});

if (!frontend.success) {
    for (const message of frontend.logs) {
        console.error(message);
    }
    process.exit(1);
}

await Promise.all([
    Bun.write(
        resolve(outputRoot, "index.html"),
        Bun.file(resolve(sourceRoot, "index.html")),
    ),
    Bun.write(
        resolve(outputRoot, "styles.css"),
        Bun.file(resolve(sourceRoot, "styles.css")),
    ),
]);

const target = await readCommand(["rustc", "--print", "host-tuple"]);
const extension = process.platform === "win32" ? ".exe" : "";
const sidecarPath = resolve(binaryRoot, `vera-${target}${extension}`);
await runCommand([
    process.execPath,
    "build",
    "--compile",
    resolve(projectRoot, "src/cli.ts"),
    "--outfile",
    sidecarPath,
]);

async function readCommand(command: string[]): Promise<string> {
    const process = Bun.spawn(command, {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "inherit",
    });
    const output = await new Response(process.stdout).text();
    const exitCode = await process.exited;
    if (exitCode !== 0) {
        throw new Error(`${command[0]} exited with code ${exitCode}`);
    }
    return output.trim();
}

async function runCommand(command: string[]): Promise<void> {
    const process = Bun.spawn(command, {
        cwd: projectRoot,
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await process.exited;
    if (exitCode !== 0) {
        throw new Error(`${command[0]} exited with code ${exitCode}`);
    }
}
