/** CLI logging level management. */
const VALID_LOG_LEVELS = ["silent", "fatal", "error", "warn", "info", "debug", "trace"] as const;

export let logLevel: string = "info";

export function setLogLevel(level: string): boolean {
  const lc = level.toLowerCase();
  if ((VALID_LOG_LEVELS as readonly string[]).includes(lc)) {
    logLevel = lc;
    if (lc === "debug" || lc === "trace") {
      process.env.LOG_LEVEL = lc;
    }
    return true;
  }
  return false;
}

export function getValidLevels(): readonly string[] {
  return VALID_LOG_LEVELS;
}