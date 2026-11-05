import { createHash } from "node:crypto";

/** Short stable key. The raw session id never leaves this process. */
export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
