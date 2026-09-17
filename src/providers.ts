/**
 * Provider chain.
 *
 * One provider is not enough: YouTube gates different endpoints differently per
 * IP, so a track list is gathered from every source that answers, and a caption
 * payload is downloaded through every URL that offers it. That is what turns a
 * "0 byte timedtext response" from a hard failure into a retry on another path.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config as defaultConfig, type Config } from "./config.js";
import { tracksFromPlayer, type CaptionTrack, type TrackSet, type VideoDetails } from "./captions.js";
import { TranscriptError, classifyPlayability, type AttemptLog } from "./errors.js";
import { detectFormat, parseTranscript, type RawFormat, type TranscriptSegment } from "./formats.js";
import { httpFetch } from "./http.js";
import {
  extractApiKey,
  extractInitialPlayerResponse,
  fetchOEmbed,
  fetchPlayerResponse,
  fetchWatchPage,
  fetchViaGetTranscript,
  segmentsFromGetTranscript,
} from "./innertube.js";

export const TIMEDTEXT_FORMATS: RawFormat[] = ["json3", "srv3", "vtt"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Caption URLs are sometimes protocol-relative. */
function absoluteTrackUrl(baseUrl: string): string {
  if (/^\/\//.test(baseUrl)) return "https:" + baseUrl;
  if (/^\//.test(baseUrl)) return "https://www.youtube.com" + baseUrl;
  return baseUrl;
}

/**
 * Remove the PO-token experiment flag that the watch page stamps onto caption
 * URLs; keeping it makes /api/timedtext answer with an empty body.
 */
export function depoTokenize(url: string): string {
  try {
    const u = new URL(absoluteTrackUrl(url));
    u.searchParams.delete("exp");
    return u.toString();
  } catch {
    return url.replace(/[?&]exp=[^&]*/, "");
  }
}

// ------------------------------------------------------------ track lists ---

async function tracksFromInnerTube(videoId: string, cfg: Config, attempts: AttemptLog[]): Promise<TrackSet> {
  const result = await fetchPlayerResponse(videoId, cfg);
  const set = tracksFromPlayer(result.json, "innertube");
  set.provider = "innertube:" + result.client;
  for (const attempt of result.attempts) attempts.push(attempt);
  return set;
}

/** Captions that YouTube has queued but not produced yet. */
function isStillGenerating(html: string): boolean {
  const flat = String(html).replace(/\s+/g, " ").toLowerCase();
  return (
    flat.includes("captions are being generated") ||
    flat.includes("subtitles are being generated") ||
    flat.includes("auto-generated captions will be available") ||
    flat.includes("captions will be available shortly")
  );
}

async function tracksFromWatchPage(videoId: string, cfg: Config, attempts: AttemptLog[]): Promise<TrackSet> {
  const html = await fetchWatchPage(videoId, cfg);
  const player = extractInitialPlayerResponse(html);
  if (!player) {
    throw new TranscriptError("PARSE_ERROR", "Could not read the player response out of the watch page.", {
      hint: "YouTube changed the page shape, or refused the request. Try again, or enable the yt-dlp provider.",
      details: { videoId, htmlBytes: html.length },
    });
  }
  const info = classifyPlayability({
    status: player.playabilityStatus?.status,
    reason: player.playabilityStatus?.reason,
    errorScreenReason: player.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText,
    isLive: Boolean(player.videoDetails?.isLiveContent),
  });
  if (info) throw new TranscriptError(info.code, info.message, { hint: info.hint, details: { videoId } });
  const set = tracksFromPlayer(player, "watch-page");
  if (!set.tracks.length && isStillGenerating(html)) {
    throw new TranscriptError("TRANSCRIPT_GENERATING", "YouTube has not finished generating captions for this video yet.", {
      hint: "Auto-generated captions usually appear within a few hours of upload; try again later.",
      details: { videoId },
    });
  }
  set.provider = "watch-page";
  // These URLs carry the PO-token experiment flag; strip it up front.
  set.tracks = set.tracks.map((t) => ({ ...t, baseUrl: depoTokenize(t.baseUrl) }));
  void attempts;
  return set;
}

// ------------------------------------------------------------- yt-dlp ------

let ytDlpPresence: Promise<boolean> | undefined;

export async function ytDlpAvailable(cfg: Config = defaultConfig): Promise<boolean> {
  if (cfg.ytDlp === "never") return false;
  ytDlpPresence ??= new Promise<boolean>((resolve) => {
    const child = spawn(cfg.ytDlpPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let ok = false;
    child.stdout?.on("data", () => (ok = true));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(ok && code === 0));
    setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
  });
  return ytDlpPresence;
}

/** Reset the cached yt-dlp presence probe (tests). */
export function resetYtDlpProbe(): void {
  ytDlpPresence = undefined;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runYtDlp(args: string[], cfg: Config, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new TranscriptError("TIMEOUT", "yt-dlp timed out after " + timeoutMs + "ms."));
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new TranscriptError(
          "PROVIDER_FAILED",
          err.code === "ENOENT"
            ? "yt-dlp was not found at " + cfg.ytDlpPath + "."
            : "Failed to start yt-dlp: " + err.message,
          { hint: err.code === "ENOENT" ? "Install yt-dlp, or set YTA_YTDLP_PATH, or set YTA_YTDLP=never to disable it." : undefined },
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function ytDlpUrl(videoId: string): string {
  return "https://www.youtube.com/watch?v=" + videoId;
}

function ytDlpCommonArgs(cfg: Config): string[] {
  const args = ["--no-warnings", "--no-progress", "--no-playlist", "--retries", "2"];
  if (cfg.cookiesFile) args.push("--cookies", cfg.cookiesFile);
  return args;
}

/** Ask yt-dlp which subtitle tracks exist (no download). */
export async function tracksFromYtDlp(videoId: string, cfg: Config, attempts: AttemptLog[]): Promise<TrackSet> {
  if (cfg.ytDlp === "never") throw new TranscriptError("PROVIDER_FAILED", "yt-dlp provider disabled (YTA_YTDLP=never).");
  if (!(await ytDlpAvailable(cfg))) throw new TranscriptError("PROVIDER_FAILED", "yt-dlp is not installed; skipping that fallback.");
  const res = await runYtDlp(
    [...ytDlpCommonArgs(cfg), "--simulate", "--skip-download", "--dump-single-json", ytDlpUrl(videoId)],
    cfg,
    Math.max(cfg.timeoutMs * 2, 45_000),
  );
  if (res.code !== 0 || !res.stdout.trim()) {
    const blurb = (res.stderr || res.stdout).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 240);
    const info = classifyPlayability({ reason: blurb });
    throw new TranscriptError(info?.code ?? "PROVIDER_FAILED", info?.message ?? "yt-dlp could not describe this video: " + blurb, {
      hint: info?.hint,
    });
  }
  const json = JSON.parse(res.stdout);
  const flatten = (map: any, generated: boolean): CaptionTrack[] =>
    Object.entries<any>(map ?? {}).map(([code, formats]) => {
      const best = (Array.isArray(formats) ? formats : []).find((f: any) => /json3|srv3|vtt/.test(String(f.ext))) ?? formats?.[0];
      return {
        languageCode: code,
        displayName: String(best?.name || formats?.[0]?.name || code),
        isGenerated: generated,
        isOriginal: /-orig(inal)?$/.test(code),
        baseUrl: String(best?.url ?? ""),
        isTranslatable: false,
        source: "yt-dlp" as const,
        trackId: String(best?.ext ?? ""),
      };
    });
  const tracks = [...flatten(json.subtitles, false), ...flatten(json.automatic_captions, true)].filter((t) => t.baseUrl);
  const details: VideoDetails = {
    videoId: json.id,
    title: json.title,
    author: json.uploader ?? json.channel,
    lengthSeconds: json.duration != null ? Number(json.duration) : undefined,
    isLive: json.is_live === true,
    isCaptionable: true,
  };
  void attempts;
  return { tracks, translationLanguages: [], autoTranslationEnabled: false, details, provider: "yt-dlp" };
}

/** Let yt-dlp do the whole download; it handles impersonation and PO tokens. */
async function segmentsFromYtDlp(
  videoId: string,
  cfg: Config,
  language: string,
  allowGenerated: boolean,
): Promise<{ segments: TranscriptSegment[]; provider: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
  const langs = [language, language + "-orig", language + "-original", language + ".*"].join(",");
  const args = [...ytDlpCommonArgs(cfg), "--skip-download", "--write-subs"];
  if (allowGenerated) args.push("--write-auto-subs");
  args.push(
    "--sub-langs", langs,
    "--sub-format", "json3/srv3/vtt/best",
    "-o", path.join(dir, "caption.%(ext)s"),
    ytDlpUrl(videoId),
  );
  try {
    const res = await runYtDlp(args, cfg, Math.max(cfg.timeoutMs * 3, 90_000));
    const files = fs.readdirSync(dir).filter((f) => /\.(json3|srv3|vtt|srt|ttml|xml)$/i.test(f));
    if (!files.length) {
      const blurb = (res.stderr || "").split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200);
      throw new TranscriptError("NO_TRANSCRIPT", "yt-dlp found no caption file for this video" + (blurb ? ": " + blurb : "."), {
        hint: "Either the video has no captions, or the language requested is not offered.",
      });
    }
    // Prefer the closest language match, then the richest format.
    const score = (f: string): number => {
      const lower = f.toLowerCase();
      const langScore = lower.includes(language.toLowerCase() + "-orig") ? 0 : lower.includes(language.toLowerCase()) ? 1 : 3;
      const fmtScore = lower.endsWith(".json3") ? 0 : lower.endsWith(".srv3") ? 1 : lower.endsWith(".vtt") ? 2 : 3;
      return langScore * 10 + fmtScore;
    };
    files.sort((a, b) => score(a) - score(b));
    const file = path.join(dir, files[0]!);
    const body = fs.readFileSync(file, "utf8");
    const format = /\.json3$/i.test(file) ? "json3" : /\.vtt$/i.test(file) ? "vtt" : /\.srv3$/i.test(file) ? "srv3" : undefined;
    return { segments: parseTranscript(body, (format ?? detectFormat(body)) as RawFormat), provider: "yt-dlp" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- gathering ---

export interface CollectedTracks extends TrackSet {
  /** Providers that contributed tracks, in the order they answered. */
  providers: string[];
  /** Providers never consulted, so a later stage can ask them if needed. */
  providersSkipped: string[];
  /** True when a provider positively said this video has no captions. */
  confirmedCaptionless: boolean;
}

export interface CollectOptions {
  /** Restrict to these provider ids. */
  only?: string[];
  /**
   * Stop at the first provider that returns tracks (default true).
   *
   * Every extra provider is another 1.5 MB watch page and another chance of a
   * throttle, so we only keep asking once there is a reason to.
   */
  stopAfterFirstTracks?: boolean;
}

/**
 * Ask providers for their caption tracks, stopping as soon as one answers.
 *
 * When a download later fails, the caller comes back with only: the skipped
 * providers, and the tracks of several providers give the downloader more URLs.
 */
export async function collectTracks(videoId: string, cfg: Config = defaultConfig, options: CollectOptions = {}): Promise<CollectedTracks> {
  const attempts: AttemptLog[] = [];
  const sets: TrackSet[] = [];
  const failures: TranscriptError[] = [];
  let confirmedCaptionless = false;
  let providersSkipped: string[] = [];

  const baseOrder = cfg.providers.length
    ? [...cfg.providers]
    : cfg.ytDlp === "always"
      ? ["yt-dlp", "innertube", "watch-page"]
      : ["innertube", "watch-page", "yt-dlp"];
  // A disabled provider is not a fallback candidate and must not appear as a
  // reason for a later failure.
  const order = cfg.ytDlp === "never" ? baseOrder.filter((id) => id !== "yt-dlp") : baseOrder;
  const wanted = options.only?.length ? order.filter((id) => options.only!.includes(id)) : order;

  for (const [index, id] of wanted.entries()) {
    try {
      const set =
        id === "innertube"
          ? await tracksFromInnerTube(videoId, cfg, attempts)
          : id === "watch-page"
            ? await tracksFromWatchPage(videoId, cfg, attempts)
            : id === "yt-dlp"
              ? await tracksFromYtDlp(videoId, cfg, attempts)
              : undefined;
      if (!set) {
        attempts.push({ provider: id, error: "unknown provider id", code: "PROVIDER_FAILED" });
        continue;
      }
      sets.push(set);
      if (id !== "yt-dlp" && !set.tracks.length) confirmedCaptionless = true;
      if (set.tracks.length && options.stopAfterFirstTracks !== false) {
        providersSkipped = wanted.slice(index + 1);
        break;
      }
    } catch (err) {
      const te = err instanceof TranscriptError ? err : new TranscriptError("PROVIDER_FAILED", String(err));
      failures.push(te);
      attempts.push({ provider: id, error: te.message, code: te.code });
    }
  }

  const merged = mergeSets(sets);
  if (!merged.tracks.length) {
    // Distinguish "no captions" from "we could not look".
    const definitive = failures.find((f) =>
      ["VIDEO_NOT_FOUND", "PRIVATE_VIDEO", "MEMBERS_ONLY", "AGE_RESTRICTED", "REGION_RESTRICTED", "LIVE_ENDED", "LIVE_NOT_STARTED", "TRANSCRIPT_GENERATING", "BOT_CHECK", "AUTH_REQUIRED", "RATE_LIMITED"].includes(f.code),
    );
    if (definitive && !confirmedCaptionless) throw definitive.withAttempts(attempts);
    if (confirmedCaptionless) {
      throw new TranscriptError("NO_TRANSCRIPT", "This video has no captions: the uploader added none and YouTube generated none.", {
        hint: "Transcripts exist only when captions exist. Try a different video, or ask for the video info to confirm.",
        details: { videoId },
      }).withAttempts(attempts);
    }
    throw (pickHeadlineFailure(failures) ?? new TranscriptError("PROVIDER_FAILED", "No provider could list caption tracks.")).withAttempts(attempts);
  }

  const providers = [...new Set(sets.map((s) => s.provider))];
  return { ...merged, providers, providersSkipped, confirmedCaptionless };
}

/** Providers that were switched off or missing are never the headline failure. */
const NOISE_FAILURE = /(provider disabled|is not installed|was not found at|not installed)/i;

function pickHeadlineFailure(failures: TranscriptError[]): TranscriptError | undefined {
  return failures.find((f) => !NOISE_FAILURE.test(f.message)) ?? failures[0];
}

function mergeSets(sets: TrackSet[]): TrackSet {
  const tracks: CaptionTrack[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    for (const track of set.tracks) {
      const key = [track.source, track.languageCode.toLowerCase(), track.isGenerated ? "asr" : "manual", track.trackId].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(track);
    }
  }
  const base = sets[0] ?? { tracks: [], translationLanguages: [], autoTranslationEnabled: false, details: {}, provider: "none" };
  const details = sets.map((s) => s.details).find((d) => d?.title) ?? base.details;
  const translationLanguages = sets.map((s) => s.translationLanguages).find((l) => l.length) ?? [];
  return {
    tracks,
    translationLanguages,
    autoTranslationEnabled: sets.some((s) => s.autoTranslationEnabled),
    details,
    provider: [...new Set(sets.map((s) => s.provider))].join("+"),
  };
}

// ------------------------------------------------------------ downloading --

async function fetchTrackBody(track: CaptionTrack, cfg: Config, attempts: AttemptLog[]): Promise<TranscriptSegment[]> {
  let lastErr: TranscriptError | undefined;
  let emptyPayloads = 0;

  for (let i = 0; i < TIMEDTEXT_FORMATS.length; i++) {
    const format = TIMEDTEXT_FORMATS[i]!;
    // A little spacing: hammering timedtext is how an IP earns a 429.
    if (i > 0) await sleep(150);
    const url = new URL(absoluteTrackUrl(depoTokenize(track.baseUrl)));
    url.searchParams.set("fmt", format);
    try {
      const res = await httpFetch(url.toString(), {
        config: cfg,
        label: "captions (" + track.languageCode + ", " + format + ")",
        tolerateStatus: true,
        retries: 0,
        headers: { referer: "https://www.youtube.com/", origin: "https://www.youtube.com" },
      });

      // A refusal is final for every format; retrying only deepens the throttle.
      if (res.status === 429) {
        throw new TranscriptError("RATE_LIMITED", "YouTube rate limit (HTTP 429) on the caption download.", {
          hint: "Wait a few minutes before retrying, or serve requests from a different IP.",
          details: { language: track.languageCode, source: track.source },
        });
      }
      if (res.status === 403) {
        throw new TranscriptError("BOT_CHECK", "YouTube refused the caption download (HTTP 403).", {
          hint: "This looks like bot detection. Add cookies from a signed-in browser (YTA_COOKIES) or enable yt-dlp.",
        });
      }
      if (res.status < 200 || res.status > 299) {
        lastErr = new TranscriptError("PROVIDER_FAILED", "Caption download returned HTTP " + res.status + ".", {
          details: { status: res.status, format },
        });
        attempts.push({ provider: "timedtext:" + track.source, error: "HTTP " + res.status + " (" + format + ")" });
        continue;
      }
      if (!res.text.trim()) {
        emptyPayloads++;
        lastErr = new TranscriptError("PARSE_ERROR", "YouTube returned an empty caption body for " + track.languageCode + ".", {
          hint: "Empty bodies mean YouTube demanded a proof-of-origin token for this IP; another provider may still work.",
          details: { status: res.status, format, source: track.source },
        });
        attempts.push({ provider: "timedtext:" + track.source, error: "empty payload (" + format + ")" });
        // Two empty answers is proof enough; a third costs nothing but time.
        if (emptyPayloads >= 2) break;
        continue;
      }
      return parseTranscript(res.text, format);
    } catch (err) {
      if (err instanceof TranscriptError && (err.code === "RATE_LIMITED" || err.code === "BOT_CHECK")) throw err;
      const te = err instanceof TranscriptError ? err : new TranscriptError("PARSE_ERROR", String(err));
      lastErr = te;
      attempts.push({ provider: "timedtext:" + track.source, error: te.message, code: te.code });
    }
  }
  throw lastErr ?? new TranscriptError("PROVIDER_FAILED", "Could not download the " + track.languageCode + " caption track.");
}

/**
 * Download the payload for the chosen track, retrying every other provider that
 * offered the same language before giving up.
 */
export async function downloadTranscript(
  videoId: string,
  chosen: CaptionTrack,
  candidates: CaptionTrack[],
  cfg: Config = defaultConfig,
): Promise<{ segments: TranscriptSegment[]; track: CaptionTrack; provider: string }> {
  const attempts: AttemptLog[] = [];
  const sameLanguage = candidates.filter(
    (t) => t.languageCode.toLowerCase() === chosen.languageCode.toLowerCase() && t.isGenerated === chosen.isGenerated,
  );
  const queue = [chosen, ...sameLanguage.filter((t) => t !== chosen)];

  const blocked: TranscriptError[] = [];
  for (const track of queue) {
    try {
      const segments = await fetchTrackBody(track, cfg, attempts);
      return { segments, track, provider: track.source };
    } catch (err) {
      const te = err instanceof TranscriptError ? err : new TranscriptError("PROVIDER_FAILED", String(err));
      attempts.push({ provider: "download:" + track.source, error: te.message, code: te.code });
      // Rate limits and bot checks will not improve by trying another URL variant.
      if (te.code === "RATE_LIMITED" || te.code === "BOT_CHECK") {
        blocked.push(te);
        break;
      }
    }
  }

  // Last HTTP resort: the transcript panel embedded in the watch page.
  if (!blocked.length) {
    try {
      const response = await fetchViaGetTranscript(videoId, cfg);
      const segments = segmentsFromGetTranscript(response);
      if (segments.length) return { segments, track: chosen, provider: "get-transcript" };
      attempts.push({ provider: "get-transcript", error: "no segments in transcript panel response" });
    } catch (err) {
      const te = err instanceof TranscriptError ? err : new TranscriptError("PROVIDER_FAILED", String(err));
      attempts.push({ provider: "get-transcript", error: te.message, code: te.code });
    }
  }

  // yt-dlp keeps its own HTTP stack (and can impersonate a real client), so it is
  // still worth trying when plain HTTP paths were refused.
  if (cfg.ytDlp !== "never") {
    try {
      const { segments, provider } = await segmentsFromYtDlp(videoId, cfg, chosen.languageCode, chosen.isGenerated);
      if (segments.length) return { segments, track: chosen, provider };
    } catch (err) {
      const te = err instanceof TranscriptError ? err : new TranscriptError("PROVIDER_FAILED", String(err));
      attempts.push({ provider: "yt-dlp", error: te.message, code: te.code });
    }
  }

  if (blocked.length) throw blocked[0]!.withAttempts(attempts);

  throw new TranscriptError(
    "PROVIDER_FAILED",
    "Every caption download path failed for the " + chosen.languageCode + " track.",
    {
      hint:
        "YouTube refused the caption URLs this session returned. Retry shortly, add cookies from a signed-in browser (YTA_COOKIES), or install yt-dlp so the request can go through a hardened client.",
      details: { videoId, language: chosen.languageCode, providersTried: [...new Set(queue.map((t) => t.source))], enabledProviders: cfg.providers.length ? cfg.providers : ["innertube", "watch-page", "yt-dlp"] },
    },
  ).withAttempts(attempts);
}

export { fetchOEmbed, fetchWatchPage, extractApiKey, fetchViaGetTranscript, segmentsFromGetTranscript };
