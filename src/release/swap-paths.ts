import { dlopen, FFIType, ptr } from "bun:ffi";

const RENAME_SWAP = 0x2;

// Exchanges two paths in one step, so neither name is ever missing. False when the system or the
// volume cannot do it, in which case nothing moved.
export function swapPaths(first: string, second: string): boolean {
    if (process.platform !== "darwin") return false;
    try {
        const library = dlopen("/usr/lib/libSystem.B.dylib", {
            renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        });
        try {
            const a = Buffer.from(`${first}\0`);
            const b = Buffer.from(`${second}\0`);
            return library.symbols.renamex_np(ptr(a), ptr(b), RENAME_SWAP) === 0;
        } finally {
            library.close();
        }
    } catch {
        return false;
    }
}
