import {
  MODEL_FAMILIES,
  PlanIdSchema,
  PROVENANCE,
  SOURCES_CORE,
  SOURCES_EXTRA,
} from "./ids";
import {
  DECLARED_BILLING,
  DECLARED_CURRENCIES,
  DECLARED_PROVENANCE,
  INTENSITIES,
  PROFILE_SCHEMA_ID,
  ProfileSchema,
  toIssues,
  type Issue,
  type Profile,
} from "./profile";

/*
 * Profile ⇄ URL fragment (`#p=1.<payload>`). The fragment never reaches the
 * server. Format v1:
 *  1. every object key and every known enum string is swapped for a short
 *     code from DICTIONARY (keys plain, values prefixed with `~`);
 *  2. the result is JSON, UTF-8, base64url without padding;
 *  3. the payload is prefixed with the format version and a dot.
 * DICTIONARY is part of the format: append only, never reorder. A different
 * order needs a new version prefix.
 * `plan_prices` is keyed by catalog plan ids, which are an open set. A key
 * that is not in the dictionary is stored with a `!` prefix when it is a plan
 * id. Codes themselves stay alphanumeric, so old fragments never use `!`.
 * Browser-safe and synchronous: TextEncoder, btoa/atob, no dependencies.
 */

export const FRAGMENT_VERSION = "1";
export const FRAGMENT_PARAM = "p";
export const MAX_FRAGMENT_LENGTH = 8_000;

const DICTIONARY: readonly string[] = [
  // keys
  "schema",
  "period",
  "plans",
  "provenance",
  "agent_hours",
  "activity",
  "by_model",
  "active_days",
  "parallel_agents_p50",
  "peak_window_load",
  "sessions",
  "daily_variation",
  "tokens",
  "intensity",
  "models_count",
  "blocks",
  "value",
  "source",
  "hours",
  "weekdays",
  "count",
  "median_minutes",
  "model",
  "input",
  "output",
  "cache_read",
  "cache_write",
  "worst",
  "weekday",
  "hour",
  "wait_hours",
  // values (sources and models are also keys of provenance / by_model)
  PROFILE_SCHEMA_ID,
  ...PROVENANCE,
  ...INTENSITIES,
  ...SOURCES_CORE,
  ...MODEL_FAMILIES,
  // appended after the original dictionary (stable codes above)
  "by_source",
  ...SOURCES_EXTRA,
  "plan",
  // declared prices (append only; v1 fragments do not use these codes)
  "plan_prices",
  "amount",
  "currency",
  "billing",
  ...DECLARED_BILLING,
  DECLARED_PROVENANCE,
  ...DECLARED_CURRENCIES,
];

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function codeFor(index: number): string {
  let code = "";
  let n = index;
  do {
    code = ALPHABET[n % ALPHABET.length] + code;
    n = Math.floor(n / ALPHABET.length);
  } while (n > 0);
  return code;
}

const TO_CODE = new Map(DICTIONARY.map((word, i) => [word, codeFor(i)]));
const FROM_CODE = new Map(DICTIONARY.map((word, i) => [codeFor(i), word]));

/** Marks a plan-id object key that is not in the dictionary. */
const RAW_KEY = "!";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

class UnpackError extends Error {}

function isPlanId(key: string): boolean {
  return PlanIdSchema.safeParse(key).success;
}

function packKey(key: string): string {
  const code = TO_CODE.get(key);
  if (code) return code;
  if (isPlanId(key)) return `${RAW_KEY}${key}`;
  throw new Error(`fragment: unknown key ${key}`);
}

function unpackKey(code: string): string {
  if (code.startsWith(RAW_KEY)) {
    const key = code.slice(RAW_KEY.length);
    if (!isPlanId(key)) throw new UnpackError(code);
    return key;
  }
  const key = FROM_CODE.get(code);
  if (key == null) throw new UnpackError(code);
  return key;
}

function pack(value: Json): Json {
  if (Array.isArray(value)) return value.map(pack);
  if (typeof value === "string") {
    const code = TO_CODE.get(value);
    return code ? `~${code}` : value;
  }
  if (value && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, inner] of Object.entries(value)) {
      out[packKey(key)] = pack(inner);
    }
    return out;
  }
  return value;
}

function unpack(value: Json): Json {
  if (Array.isArray(value)) return value.map(unpack);
  if (typeof value === "string") {
    if (!value.startsWith("~")) return value;
    const word = FROM_CODE.get(value.slice(1));
    if (word == null) throw new UnpackError(value);
    return word;
  }
  if (value && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [code, inner] of Object.entries(value)) {
      out[unpackKey(code)] = unpack(inner);
    }
    return out;
  }
  return value;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(payload: string): string {
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export type ProfileToHashOptions = {
  /**
   * When true, declared `plan_prices` are included in the fragment.
   * Default false so shared links do not expose exact amounts.
   */
  includeDeclaredPrices?: boolean;
};

/** Profile payload for a URL fragment (share-safe by default). */
export function profileForFragment(
  profile: Profile,
  options?: ProfileToHashOptions,
): Profile {
  const valid = ProfileSchema.parse(profile);
  if (options?.includeDeclaredPrices || valid.plan_prices == null) {
    return valid;
  }
  const { plan_prices: _prices, ...rest } = valid;
  return ProfileSchema.parse(rest);
}

/** Encodes a valid profile; throws if it does not pass the schema. */
export function encodeProfile(profile: Profile): string {
  const valid = ProfileSchema.parse(profile);
  return `${FRAGMENT_VERSION}.${toBase64Url(JSON.stringify(pack(valid as Json)))}`;
}

export type DecodeError =
  | "empty"
  | "too_long"
  | "version"
  | "encoding"
  | "schema";

export type DecodeResult =
  | { ok: true; profile: Profile }
  | { ok: false; error: DecodeError; issues: Issue[] };

function fail(error: DecodeError, issues: Issue[] = []): DecodeResult {
  return { ok: false, error, issues };
}

/** Decodes `1.<payload>`. Never throws: garbage gives `{ ok: false }`. */
export function decodeProfile(encoded: string): DecodeResult {
  if (typeof encoded !== "string") return fail("encoding");
  const text = encoded.trim();
  if (!text) return fail("empty");
  if (text.length > MAX_FRAGMENT_LENGTH) return fail("too_long");
  const dot = text.indexOf(".");
  if (dot < 0 || text.slice(0, dot) !== FRAGMENT_VERSION)
    return fail("version");
  const payload = text.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return fail("encoding");

  let data: Json;
  try {
    data = unpack(JSON.parse(fromBase64Url(payload)) as Json);
  } catch {
    return fail("encoding");
  }
  const result = ProfileSchema.safeParse(data);
  if (!result.success) return fail("schema", toIssues(result.error));
  return { ok: true, profile: result.data };
}

/** `#p=1.…` for a profile. Omits declared prices unless opted in. */
export function profileToHash(
  profile: Profile,
  options?: ProfileToHashOptions,
): string {
  return `#${FRAGMENT_PARAM}=${encodeProfile(profileForFragment(profile, options))}`;
}

/** Reads `p` from a location hash such as `#p=1.…` or `#x=1&p=1.…`. */
export function profileFromHash(hash: string): DecodeResult {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return decodeProfile(params.get(FRAGMENT_PARAM) ?? "");
}
