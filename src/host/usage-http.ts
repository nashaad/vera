/**
 * Compatibility wrapper. The annex server lives in src/annex/. The host still
 * starts it in-process until it spawns vera-annex as a child.
 */
export {
    startAnnexServer as startUsageWebServer,
    type AnnexServer as UsageWebServer,
    type StartAnnexServerOptions as StartUsageWebServerOptions,
} from "../annex/server.ts";
