/**
 * InnerTube: the private API the YouTube web/mobile clients use.
 *
 * Which client you pretend to be decides almost everything. The WEB player
 * response is increasingly gated behind a proof-of-origin token (we then see
 * playabilityStatus UNPLAYABLE, or caption URLs that answer with 0 bytes),
 * while the mobile clients still return ordinary caption URLs. So we ask
 * several clients and take the first useful answer.
 */

import { TranscriptError, classifyPlayability, type AttemptLog } from "./errors.js";
import { httpFetch } from "./http.js";
import type { Config } from "./config.js";

/** Public API key shipped with the web client; scraped values win when present. */
export const FALLBACK_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

export interface ClientSpec {
  id: string;
  clientName: string;
  clientVersion: string;
  /** Extra context.client fields (Android SDK level, iOS device model, ...). */
  client?: Record<string, unknown>;
  /** Extra top-level context fields (TV embedded player needs thirdParty). */
  context?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Set when this client is worth trying only for age-restricted content. */
  requiresThirdParty?: boolean;
}

/** Ordered attempts: mobile first (fewer gates), web last. */
export const PLAYER_CLIENTS: ClientSpec[] = [
  {
    id: "android",
    clientName: "ANDROID",
    clientVersion: "20.49.42",
    client: { androidSdkVersion: 35, authUser: 0 },
    headers: { "x-youtube-client-name": "3" },
  },
  {
    id: "ios",
    clientName: "IOS",
    clientVersion: "20.10.4",
    client: { deviceModel: "iPhone16,2", userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)" },
    headers: { "x-youtube-client-name": "5" },
  },
  {
    id: "android-testpipe",
    clientName: "ANDROID",
    clientVersion: "19.09.37",
    client: { androidSdkVersion: 30, authUser: 0, experiments: "23804281,24651219" },
    headers: { "x-youtube-client-name": "3" },
  },
  {
    id: "mweb",
    clientName: "MWEB",
    clientVersion: "2.20250311.01.00",
    headers: { "x-youtube-client-name": "2" },
  },
  {
    id: "tv-embedded",
    clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
    clientVersion: "2.0",
    context: { thirdParty: { embedUrl: "https://www.youtube.com/", embedReferrerUrl: "https://www.youtube.com/" } },
    requiresThirdParty: true,
  },
  { id: "web", clientName: "WEB", clientVersion: "2.20260911.01.00", headers: { "x-youtube-client-name": "1" } },
];

/** Extract the object/array that starts at \`openIndex\` using brace balancing. */
export function extractBalancedJson(text: string, openIndex: number): string | undefined {
  const open = text[openIndex];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return undefined;
}

function findObjectAfter(text: string, needle: string): any | undefined {
  const idx = text.indexOf(needle);
  if (idx === -1) return undefined;
  const brace = text.indexOf("{", idx);
  if (brace === -1) return undefined;
  const raw = extractBalancedJson(text, brace);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** window.ytInitialPlayerResponse from a watch page. */
export function extractInitialPlayerResponse(html: string): any | undefined {
  return (
    findObjectAfter(html, "ytInitialPlayerResponse =") ??
    findObjectAfter(html, "ytInitialPlayerResponse=") ??
    findObjectAfter(html, '"ytInitialPlayerResponse":')
  );
}

/** window.ytInitialData from a watch page (holds the transcript endpoint). */
export function extractInitialData(html: string): any | undefined {
  return findObjectAfter(html, "ytInitialData =") ?? findObjectAfter(html, "ytInitialData=");
}

export function extractApiKey(html: string): string | undefined {
  return html.match(/"INNERTUBE_API_KEY":"([^"]{20,60})"/)?.[1];
}

export function extractClientVersion(html: string): string | undefined {
  return html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
}

export interface PlayerAttempt {
  client: string;
  status: number;
  json: any;
}

export interface PlayerResult {
  /** Winning player response. */
  json: any;
  client: string;
  /** Every attempt, newest first, for diagnostics. */
  attempts: AttemptLog[];
}

function playerHeaders(cfg: Config, spec: ClientSpec): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    origin: "https://www.youtube.com",
    referer: "https://www.youtube.com/",
    "x-youtube-client-name": spec.headers?.["x-youtube-client-name"] ?? "1",
    "x-youtube-client-version": spec.clientVersion,
  };
}

/**
 * Call the InnerTube player endpoint for one client.
 * Never throws for HTTP-level refusals; returns null instead so callers can try
 * the next client and only report an aggregate failure at the end.
 */
export async function fetchPlayerWithClient(
  videoId: string,
  spec: ClientSpec,
  cfg: Config,
  apiKey: string = FALLBACK_API_KEY,
): Promise<PlayerAttempt | null> {
  const client: Record<string, unknown> = {
    clientName: spec.clientName,
    clientVersion: spec.clientVersion,
    hl: cfg.hl,
    gl: cfg.gl,
    ...(spec.client ?? {}),
  };
  const context: Record<string, unknown> = { client, ...(spec.context ?? {}) };
  const body = JSON.stringify({ context, videoId, contentCheckOk: true, racyCheckOk: true });
  const url = "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(apiKey) + "&prettyPrint=false";
  const res = await httpFetch(url, {
    config: cfg,
    method: "POST",
    body,
    headers: playerHeaders(cfg, spec),
    label: "player (" + spec.id + ")",
    tolerateStatus: true,
  });
  if (res.status === 429) throw new TranscriptError("RATE_LIMITED", "YouTube rate limit (HTTP 429) hit.", { retryable: true });
  if (res.status < 200 || res.status > 299) return null;
  let json: any;
  try {
    json = JSON.parse(res.text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  return { client: spec.id, status: res.status, json };
}

function trackCount(json: any): number {
  const t = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(t) ? t.length : 0;
}

function isPlayable(json: any): boolean {
  const s = String(json?.playabilityStatus?.status ?? "").toUpperCase();
  return !s || s === "OK" || s.startsWith("LIVE");
}

/**
 * Ask clients in order until one yields a usable player response.
 *
 * "Usable" means it has caption tracks, or it explains definitively why the
 * video cannot be served (so we can report that instead of retrying pointlessly).
 */
export async function fetchPlayerResponse(
  videoId: string,
  cfg: Config,
  clients: ClientSpec[] = PLAYER_CLIENTS,
): Promise<PlayerResult> {
  const attempts: AttemptLog[] = [];
  let fallback: PlayerAttempt | null = null;
  let transient: { code: import("./errors.js").ErrorCode; message: string; hint?: string } | undefined;

  for (const spec of clients) {
    try {
      const attempt = await fetchPlayerWithClient(videoId, spec, cfg);
      if (!attempt) {
        attempts.push({ provider: "innertube:" + spec.id, error: "empty or non-JSON player response" });
        continue;
      }
      const count = trackCount(attempt.json);
      if (count > 0) return { json: attempt.json, client: spec.id, attempts };
      if (isPlayable(attempt.json) && !fallback) fallback = attempt;
      if (!isPlayable(attempt.json)) {
        const info = classifyPlayability({
          status: attempt.json?.playabilityStatus?.status,
          reason: attempt.json?.playabilityStatus?.reason,
          errorScreenReason: attempt.json?.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText,
          isLive: Boolean(attempt.json?.videoDetails?.isLiveContent),
        });
        // A verdict about the video itself is authoritative. An anti-bot refusal
        // is only this client's opinion on this connection, so walk past it and let
        // the other clients and providers have a turn.
        if (info && info.code !== "BOT_CHECK") {
          throw new TranscriptError(info.code, info.message, { hint: info.hint, details: { videoId, client: spec.id } });
        }
        if (info) transient = info;
        attempts.push({ provider: "innertube:" + spec.id, error: info?.message ?? "not playable" });
        continue;
      }
      attempts.push({ provider: "innertube:" + spec.id, error: "playable but listed no caption tracks" });
    } catch (err) {
      if (err instanceof TranscriptError) {
        if (err.code === "RATE_LIMITED" || err.code === "BOT_CHECK") throw err;
        attempts.push({ provider: "innertube:" + spec.id, error: err.message, code: err.code });
        continue;
      }
      throw err;
    }
  }

  if (fallback) return { json: fallback.json, client: fallback.client, attempts };
  if (transient) {
    throw new TranscriptError(transient.code, transient.message, { hint: transient.hint, details: { videoId } }).withAttempts(attempts);
  }
  throw new TranscriptError("PROVIDER_FAILED", "No InnerTube client would describe this video.", {
    details: { videoId },
  }).withAttempts(attempts);
}

/** Fetch the desktop watch page (HTML). */
export async function fetchWatchPage(videoId: string, cfg: Config, hl: string = cfg.hl): Promise<string> {
  const url =
    "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&hl=" + encodeURIComponent(hl) + "&gl=" + encodeURIComponent(cfg.gl);
  const res = await httpFetch(url, {
    config: cfg,
    label: "watch page",
    tolerateStatus: true,
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  if (res.status === 404) throw new TranscriptError("VIDEO_NOT_FOUND", "YouTube says this video page does not exist (HTTP 404).", { details: { videoId } });
  if (res.status === 429) throw new TranscriptError("RATE_LIMITED", "YouTube rate limit (HTTP 429) hit while loading the watch page.", { retryable: true });
  if (res.status < 200 || res.status > 299) {
    throw new TranscriptError("PROVIDER_FAILED", "Watch page returned HTTP " + res.status + ".", { details: { videoId, status: res.status } });
  }
  if (/"playabilityStatus":\s*{\s*"status":\s*"LOGIN_REQUIRED"/i.test(res.text) && !cfg.cookies) {
    throw new TranscriptError("AUTH_REQUIRED", "YouTube requires a signed-in session for this video page.", {
      hint: "Set YTA_COOKIES (or YTA_COOKIES_FILE) from a browser session.",
      details: { videoId },
    });
  }
  return res.text;
}

export interface OEmbedInfo {
  title?: string;
  authorName?: string;
  thumbnailUrl?: string;
}

/** Cheap public metadata lookup; also doubles as a "does this video exist" probe. */
export async function fetchOEmbed(videoId: string, cfg: Config): Promise<OEmbedInfo | undefined> {
  try {
    const url = "https://www.youtube.com/oembed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + videoId) + "&format=json";
    const res = await httpFetch(url, { config: cfg, label: "oEmbed", tolerateStatus: true, retries: 0 });
    if (res.status !== 200) return undefined;
    const json = JSON.parse(res.text);
    return { title: json.title, authorName: json.author_name, thumbnailUrl: json.thumbnail_url };
  } catch {
    return undefined;
  }
}

/**
 * Last-resort HTTP provider: the watch page embeds a pre-encoded
 * getTranscriptEndpoint param; posting it to /get_transcript returns the
 * transcript panel (including its language menu) without touching timedtext.
 *
 * YouTube gates this endpoint by session/IP reputation, so it is attempted last.
 */
export async function fetchViaGetTranscript(videoId: string, cfg: Config, hl?: string): Promise<any> {
  const html = await fetchWatchPage(videoId, cfg, hl);
  const params = html.match(/"getTranscriptEndpoint":\s*{\s*"params":"([^"]+)"/)?.[1];
  if (!params) {
    throw new TranscriptError("NO_TRANSCRIPT", "The watch page offered no transcript panel for this video.", {
      hint: "YouTube only embeds a transcript panel when the video has captions.",
      details: { videoId },
    });
  }
  const apiKey = extractApiKey(html) ?? FALLBACK_API_KEY;
  const clientVersion = extractClientVersion(html);
  const context =
    findObjectAfter(html, "window.INNERTUBE_CONTEXT =") ??
    findObjectAfter(html, "INNERTUBE_CONTEXT:") ?? { client: { clientName: "WEB", clientVersion, hl: cfg.hl, gl: cfg.gl } };
  if (clientVersion && context?.client) context.client.clientVersion = clientVersion;
  const res = await httpFetch("https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false", {
    config: cfg,
    method: "POST",
    body: JSON.stringify({ context, params }),
    headers: {
      "content-type": "application/json",
      origin: "https://www.youtube.com",
      referer: "https://www.youtube.com/watch?v=" + videoId,
      "x-youtube-client-name": "1",
      ...(clientVersion ? { "x-youtube-client-version": clientVersion } : {}),
    },
    label: "get_transcript",
    tolerateStatus: true,
  });
  if (res.status < 200 || res.status > 299) {
    const code = res.status === 400 ? "PROVIDER_FAILED" : res.status === 429 ? "RATE_LIMITED" : "PROVIDER_FAILED";
    throw new TranscriptError(code, "get_transcript returned HTTP " + res.status + ".", {
      hint: "This endpoint is gated per session; the primary providers usually cover it.",
      details: { status: res.status },
    });
  }
  return JSON.parse(res.text);
}

/** Pull transcript segments out of a get_transcript response. */
export function segmentsFromGetTranscript(response: any): { startMs: number; endMs?: number; text: string }[] {
  const found: any[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.transcriptSegmentRenderer) found.push(node.transcriptSegmentRenderer);
    for (const value of Object.values(node)) walk(value);
  };
  walk(response);
  const out = found.map((s) => {
    const text = clean((s.snippet?.runs ?? []).map((r: any) => r.text ?? "").join(""));
    const startMs = Number(s.startMs ?? s.startTimeMs ?? NaN);
    const startText = s.startText?.simpleText;
    return {
      startMs: Number.isFinite(startMs) ? startMs : clockToMs(String(startText ?? "0")),
      endMs: s.endMs != null ? Number(s.endMs) : undefined,
      text,
    };
  });
  return out.filter((s) => s.text);
}

function clean(s: string): string {
  return String(s).replace(/\s+/g, " ").trim();
}

function clockToMs(clock: string): number {
  const parts = String(clock).trim().split(":").map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  if (parts.length === 3) return (parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1000;
  if (parts.length === 2) return (parts[0]! * 60 + parts[1]!) * 1000;
  return (parts[0] ?? 0) * 1000;
}
