import { activateTheme } from "./activate.ts";
import { setImportedThemes } from "./imported-registry.ts";
import { readStoredTheme, readThemeCache } from "./storage.ts";

// Loaded as a blocking script in the page head so the first paint already has the stored theme.
const cached = readThemeCache();
if (cached !== undefined) setImportedThemes([cached]);
activateTheme(readStoredTheme());
