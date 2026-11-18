import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in for node_modules/electron/dist/Electron.app: the same names and plists, with scripts for executables.
const HELPERS = ["Electron Helper", "Electron Helper (GPU)", "Electron Helper (Plugin)", "Electron Helper (Renderer)"];

function plist(entries: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${entries}</dict></plist>\n`;
}

export function fakeElectronApp(parent: string): string {
    const app = join(parent, "Electron.app");
    const contents = join(app, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(join(contents, "MacOS", "Electron"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(contents, "Resources", "default_app.asar"), "asar");
    writeFileSync(join(contents, "Resources", "electron.icns"), "old icon");
    writeFileSync(join(contents, "Info.plist"), plist(
        "<key>CFBundleName</key><string>Electron</string>"
        + "<key>CFBundleExecutable</key><string>Electron</string>"
        + "<key>CFBundleIdentifier</key><string>com.github.Electron</string>"
        + "<key>ElectronAsarIntegrity</key><dict><key>Resources/default_app.asar</key><dict/></dict>",
    ));
    for (const name of HELPERS) {
        const helper = join(contents, "Frameworks", `${name}.app`, "Contents");
        mkdirSync(join(helper, "MacOS"), { recursive: true });
        writeFileSync(join(helper, "MacOS", name), "#!/bin/sh\n", { mode: 0o755 });
        writeFileSync(join(helper, "Info.plist"), plist(
            `<key>CFBundleName</key><string>${name}</string><key>CFBundleIdentifier</key><string>com.github.Electron.helper</string>`,
        ));
    }
    return app;
}
