/**
 * Small HTTP layer on top of global fetch: timeouts, bounded retries with
 * backoff, and translation of YouTube-specific refusals into our error codes.
 */

import { TranscriptError, type ErrorCode } from "./errors.js";
import { config, type Config } from "./config.js";

export interface HttpOptions {
  config?: Config;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  /** Return the body even for non-2xx instead of throwing. */
  tolerateStatus?: boolean;
  label?: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  url: string;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Classify an HTTP response that indicates YouTube refused us. */
export function classifyResponseError(status: number, body: string): ErrorCode | undefined {
  if (status === 429) return "RATE_LIMITED";
  if (status === 403) return "BOT_CHECK";
  if (status === 401) return "AUTH_REQUIRED";
  if (status >= 500) return "NETWORK_ERROR";
  if (/unusual traffic|not a bot|sorry for the interruption|verify you are a human|captcha/i.test(body)) {
    return "BOT_CHECK";
  }
  return undefined;
}

/** Strip signed query parameters before a URL appears in an error message. */
export function sanitize(url: string): string {
  try {
    const u = new URL(url);
    const keep = new Set(["v", "lang", "fmt", "hl", "key"]);
    for (const k of [...u.searchParams.keys()]) if (!keep.has(k)) u.searchParams.delete(k);
    return u.origin + u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "");
  } catch {
    return String(url).split("?")[0] ?? String(url);
  }
}

export async function httpFetch(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
  const cfg = options.config ?? config;
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const retries = options.retries ?? cfg.retries;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timed out after " + timeoutMs + "ms")), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "user-agent": cfg.userAgent,
        "accept-language": cfg.hl + ",en;q=0.9",
        accept: "*/*",
        ...(cfg.cookies ? { cookie: cfg.cookies } : {}),
        ...options.headers,
      };
      const res = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body,
        signal: controller.signal,
        redirect: "follow",
      } as RequestInit);
      const text = await res.text();
      const refusal = classifyResponseError(res.status, text);

      if (res.ok || options.tolerateStatus) {
        return { status: res.status, headers: res.headers, url: res.url, text };
      }

      const retryableStatus = res.status === 429 || res.status >= 500;
      if (retryableStatus && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15_000) : 400 * 2 ** attempt);
        continue;
      }

      const code: ErrorCode = refusal ?? (res.status === 404 ? "VIDEO_NOT_FOUND" : "PROVIDER_FAILED");
      throw new TranscriptError(
        code,
        "YouTube returned HTTP " + res.status + (options.label ? " for " + options.label : "") + ".",
        { retryable: retryableStatus, details: { status: res.status, url: sanitize(url) } },
      );
    } catch (err) {
      lastError = err;
      if (err instanceof TranscriptError) throw err;
      const e = err as Error;
      const isAbort = e?.name === "AbortError" || /timed out/i.test(e?.message ?? "");
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new TranscriptError(
        isAbort ? "TIMEOUT" : "NETWORK_ERROR",
        isAbort
          ? "Request to YouTube timed out after " + timeoutMs + "ms."
          : "Network error while contacting YouTube: " + (e?.message ?? String(err)),
        { cause: err, details: { url: sanitize(url) } },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new TranscriptError("NETWORK_ERROR", "Request failed");
}
