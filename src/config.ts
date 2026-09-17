import { readFileSync } from "node:fs";
import { ACTIVE_CAPACITY } from "./access.js";

export function loadConfig(filePath: string): { capacity: number; diagnostics: string[] } {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
    const capacity = "capacity" in value ? value.capacity : ACTIVE_CAPACITY;
    if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("capacity must be a positive safe integer.");
    }
    return { capacity, diagnostics: [] };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { capacity: ACTIVE_CAPACITY, diagnostics: [] };
    return { capacity: ACTIVE_CAPACITY, diagnostics: [`${filePath}: ${error instanceof Error ? error.message : String(error)} Using capacity ${ACTIVE_CAPACITY}.`] };
  }
}
