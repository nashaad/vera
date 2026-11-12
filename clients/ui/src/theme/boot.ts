import { activateTheme } from "./activate.ts";
import { readStoredTheme } from "./storage.ts";

// Loaded as a blocking script in the page head so the first paint already has the stored theme.
activateTheme(readStoredTheme());
