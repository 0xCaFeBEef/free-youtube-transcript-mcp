/**
 * Runtime configuration, read from the environment with sane defaults.
 *
 * Every knob exists because YouTube behaves differently per IP, per region and
 * per client; being able to nudge one variable is usually what makes a failing
 * deployment work.
 */

import fs from "node:fs";
import path from "node:path";

export type YtDlpMode = "auto" | "never" | "always";

export interface Config {
  /** Per-request timeout for a single HTTP call to YouTube. */
  timeoutMs: number;
  /** Retries for transport-level failures (429/5xx/network). */
  retries: number;
  /** Interface language used when asking YouTube for caption track names. */
  hl: string;
  /** Geo-locale (2-letter country code). */
  gl: string;
  userAgent: string;
  /** Raw Cookie header sent to YouTube (age-restricted or own private videos). */
  cookies?: string;
  /** Characters returned by get_transcript before truncating. */
  maxChars: number;
  /** In-memory cache lifetime. */
  cacheTtlMs: number;
  /** When to fall back to a local yt-dlp binary. */
  ytDlp: YtDlpMode;
  ytDlpPath: string;
  /** Netscape cookie file handed to yt-dlp (--cookies). */
  cookiesFile?: string;
  /** Ordered provider ids; defaults to the built-in chain. */
  providers: string[];
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const num = (v: string | undefined, fallback: number): number => {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Convert a Netscape cookie file (the format yt-dlp and browser extensions emit)
 * into a Cookie header value.
 */
export function netscapeCookiesToHeader(text: string, hostHint = "youtube.com"): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const parts = l.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0] ?? "";
    const expires = parts[4] ?? "";
    const name = parts[5] ?? "";
    const value = parts.slice(6).join("\t");
    if (!name) continue;
    if (/^\d+$/.test(expires) && Number(expires) !== 0 && Number(expires) * 1000 < Date.now()) continue;
    const bare = domain.replace(/^\./, "");
    if (bare && !hostHint.endsWith(bare) && !bare.endsWith(hostHint)) continue;
    out.push(name + "=" + value);
  }
  return out.join("; ");
}

function resolveHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return (process.env.HOME ?? "") + p.slice(1);
  return p;
}

/** Cookies from YTA_COOKIES, or parsed from YTA_COOKIES_FILE. */
function readCookies(): string | undefined {
  const envCookies = process.env.YTA_COOKIES?.trim();
  if (envCookies) return envCookies;
  const file = process.env.YTA_COOKIES_FILE?.trim();
  if (!file) return undefined;
  try {
    const text = fs.readFileSync(resolveHome(file), "utf8");
    const header = netscapeCookiesToHeader(text);
    if (header) return header;
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.includes("=")) return flat;
  } catch {
    /* an unreadable cookie file must not break the server */
  }
  return undefined;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const providers = (env.YTA_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    timeoutMs: num(env.YTA_TIMEOUT_MS, 20_000),
    retries: num(env.YTA_RETRIES, 2),
    hl: env.YTA_HL ?? "en",
    gl: env.YTA_GL ?? "US",
    userAgent: env.YTA_USER_AGENT ?? DEFAULT_USER_AGENT,
    cookies: readCookies(),
    maxChars: num(env.YTA_MAX_CHARS, 200_000),
    cacheTtlMs: num(env.YTA_CACHE_TTL_MS, 5 * 60_000),
    ytDlp: ((env.YTA_YTDLP ?? "auto") as YtDlpMode) || "auto",
    ytDlpPath: env.YTA_YTDLP_PATH ?? "yt-dlp",
    cookiesFile: env.YTA_COOKIES_FILE?.trim() ? resolveHome(env.YTA_COOKIES_FILE.trim()) : undefined,
    providers,
    ...overrides,
  };
}

export const config = loadConfig();
