import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

export type LaunchVeraHome =
    | { readonly state: "unreadable" }
    | { readonly state: "unset" }
    | { readonly state: "set"; readonly home: string };

// Reads the environment a process was launched with. Undefined when the OS will not say.
export function launchEnvironment(pid: number): Buffer | undefined {
    try {
        return process.platform === "darwin"
            ? macLaunchEnvironment(pid)
            : process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`) : undefined;
    } catch {
        return undefined;
    }
}

// Distinguishes an environment with no VERA_HOME from one that could not be read.
export function readLaunchVeraHome(pid: number): LaunchVeraHome {
    const environment = launchEnvironment(pid);
    if (environment === undefined) return { state: "unreadable" };
    const entry = environment.toString("utf8").split("\0").find((value) => value.startsWith("VERA_HOME="));
    return entry === undefined ? { state: "unset" } : { state: "set", home: entry.slice("VERA_HOME=".length) };
}

export function clientLaunchHome(pid: number): string | undefined {
    const launch = readLaunchVeraHome(pid);
    return launch.state === "set" ? launch.home : undefined;
}

function macLaunchEnvironment(pid: number): Buffer | undefined {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
        sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    try {
        const mib = new Int32Array([1, 49, pid]);
        const size = new BigUint64Array(1);
        if (library.symbols.sysctl(ptr(mib), 3, null, ptr(size), null, 0) !== 0) return undefined;
        const length = Number(size[0]);
        if (length < 4 || length > 16 * 1024 * 1024) return undefined;
        const data = Buffer.alloc(length);
        if (library.symbols.sysctl(ptr(mib), 3, ptr(data), ptr(size), null, 0) !== 0) return undefined;
        const argc = data.readInt32LE(0);
        if (argc < 0 || argc > 65536) return undefined;
        let offset = data.indexOf(0, 4);
        if (offset < 0) return undefined;
        while (offset < data.length && data[offset] === 0) offset++;
        for (let index = 0; index < argc; index++) {
            offset = data.indexOf(0, offset);
            if (offset < 0) return undefined;
            offset++;
        }
        return data.subarray(offset, Number(size[0]));
    } finally {
        library.close();
    }
}
