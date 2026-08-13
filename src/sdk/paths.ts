/**
 * Where an extension keeps its own state. Joining `homedir()` with `.vera`
 * lands outside every tier: shared by profiles that meant to be separate, and
 * left behind by anyone copying a profile elsewhere.
 */
export {
    veraProfileDirectory,
    veraRuntimeDirectory,
    veraUserDirectory,
} from "../profile-paths.ts";
