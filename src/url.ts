/**
 * YouTube URL / reference parsing.
 *
 * Goal: accept anything a user may paste and either resolve it to a canonical
 * 11-character video id, or explain precisely why the reference cannot identify
 * a single video. The shapes follow what YouTube itself emits plus the extractor
 * families yt-dlp / youtube-dl have had to support over a decade.
 */

import { TranscriptError } from "./errors.js";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** Playlist ids seen in the wild: PL UU RD OL FL VQ PU AU LC and F<hex>. */
const PLAYLIST_ID_RE = /^(?:PL|UU|RD|OL|FL|VQ|PU|AU|LC|F[0-9A-F]{2})[A-Za-z0-9_-]{10,}$/;

/** Exact host families; deliberately strict so look-alike domains are refused. */
const HOST_PATTERNS: RegExp[] = [
  /^(?:www\.|m\.|music\.|gaming\.|studio\.|support\.)?youtube\.com$/i,
  /^youtube\.com\.[a-z]{2}$/i,
  /^(?:www\.)?youtube\.co\.[a-z]{2,3}$/i,
  /^(?:www\.)?youtube\.[a-z]{2,3}$/i,
  /^(?:www\.)?youtube-nocookie\.com$/i,
  /^(?:www\.)?youtu\.be$/i,
  /^youtube\.googleapis\.com$/i,
];

export type ReferenceKind =
  | "video"
  | "playlist"
  | "clip"
  | "channel"
  | "user"
  | "handle"
  | "search"
  | "feed"
  | "post"
  | "home"
  | "other"
  | "unknown";

export interface ParsedTarget {
  kind: ReferenceKind;
  /** Canonical 11-char video id (present when kind === "video"). */
  videoId?: string;
  /** list= / playlist id when one came along. */
  playlistId?: string;
  /** Requested start offset in seconds (t, start, #t=). */
  startSeconds?: number;
  /** Requested end offset in seconds (end, end_s). */
  endSeconds?: number;
  /** Normalized absolute URL when the input was URL-shaped. */
  canonicalUrl?: string;
  /** Host as supplied (lower-cased). */
  host?: string;
  /** Non-fatal observations worth surfacing to the caller. */
  notes: string[];
}

/** Strip markdown link syntax, angle brackets, surrounding prose, punctuation. */
function cleanInput(input: string): string {
  let s = String(input ?? "").trim();
  if (!s) return "";
  const md = s.match(/\((?:<[^)>]+>|[^)]+)\)\s*$/);
  if (md) {
    const inner = s.slice(md.index! + 1, md.index! + md[0].length - 1).replace(/[<>]/g, "").trim();
    if (/youtu|watch|\?v=/i.test(inner)) s = inner;
  }
  const angle = s.match(/^<(.+)>$/);
  if (angle) s = angle[1]!.trim();
  if (/\s/.test(s) && !VIDEO_ID_RE.test(s)) {
    const found = s.match(/(?:https?:\/\/|www\.|m\.|music\.|youtu\.be\/)[^\s<>"\u0060]+/i);
    if (found) s = found[0];
  }
  s = s.replace(/^["'\u0060\u201C\u201D\u2018\u2019]+|["'\u0060\u201C\u201D\u2018\u2019]+$/g, "");
  s = s.replace(/[\s),.;:!?]+$/g, "");
  return s;
}

/**
 * Parse a clock offset. Accepts 90, 90s, 1m30s, 1h2m3s, 01:30, 1:02:03, 42.5.
 */
export function parseTimestamp(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.floor(Number(raw));
  if (raw.includes(":") && /^(\d+:)?(\d{1,2}:)?\d{1,2}(?:\.\d+)?$/.test(raw)) {
    const parts = raw.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return undefined;
    if (parts.length === 2) return parts[0]! * 60 + Math.floor(parts[1]!);
    if (parts.length === 3) return parts[0]! * 3600 + Math.floor(parts[1]!) * 60 + Math.floor(parts[2]!);
    return undefined;
  }
  const units = raw.match(/^(?:(\d+)h)?(?:(\d+)m(?:in)?)?(?:(\d+)s?)?(?:\.\d+)?$/);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  return undefined;
}

function normalizeCandidateUrl(candidate: string): string | undefined {
  let s = String(candidate).trim();
  if (!s) return undefined;
  if (/^\/\//.test(s)) s = "https:" + s;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[^/\s]+\./.test(s)) s = "https://" + s;
    else if (s.startsWith("/")) s = "https://www.youtube.com" + s;
    else return undefined;
  }
  try {
    return new URL(s).toString();
  } catch {
    return undefined;
  }
}

export function isYouTubeHost(host: string): boolean {
  const h = String(host).toLowerCase().replace(/\.+$/, "");
  return HOST_PATTERNS.some((re) => re.test(h));
}

/** Validate a candidate id, throwing a precise diagnostic when it is not one. */
export function validateVideoId(candidate: string, origin = "video id"): string {
  const id = String(candidate ?? "").trim();
  if (VIDEO_ID_RE.test(id)) return id;
  let reason = "The " + origin + " " + JSON.stringify(id) + " is not a valid YouTube video id.";
  if (PLAYLIST_ID_RE.test(id) || id.length > 18) {
    reason += " That looks like a playlist id; playlists have no single transcript, so pass one of its video URLs.";
  } else if (id.length !== 11) {
    reason += " Video ids are exactly 11 characters (got " + id.length + ").";
  } else {
    reason += " Video ids use only A-Z, a-z, 0-9, - and _.";
  }
  throw new TranscriptError("INVALID_VIDEO_ID", reason, { details: { origin, candidate: id, length: id.length } });
}

interface Route {
  kind: ReferenceKind;
  videoId?: string;
  notes: string[];
}

/** Route a watch/embed/shorts/live/... path to a video id. */
function routePath(pathname: string, host: string): Route | undefined {
  const notes: string[] = [];
  const path = decodeURIComponent(pathname).replace(/\/index\.html?$/i, "").replace(/\/+$/, "") || "/";
  const seg = path.split("/").filter(Boolean);
  const lower = seg.map((s) => s.toLowerCase());
  const first = lower[0] ?? "";
  const isYoutuBe = /(^|\.)youtu\.be$/i.test(host);

  const takeId = (value: string | undefined, origin: string): string | undefined => {
    if (!value) return undefined;
    if (value.includes("=") || value.length > 64) return undefined; // route word, not an id
    if (VIDEO_ID_RE.test(value)) return value;
    if (PLAYLIST_ID_RE.test(value)) throw playlistError(value);
    validateVideoId(value, origin);
    return undefined;
  };

  // /watch, /watch/<id>, /v/<id>, /vi/<id>, /e/<id>, /get_video_info?video_id=
  if (first === "watch" || first === "v" || first === "vi" || first === "e" || first.startsWith("get_video")) {
    const pathId = seg.length >= 2 ? takeId(seg[1], "path segment") : undefined;
    return { kind: "video", videoId: pathId, notes };
  }

  // /embed/<id>, /embed/live_stream?channel=..&v=.., /shorts/<id>, /live/<id>
  if (first === "embed" || first === "shorts" || first === "live" || first === "shortvideo" || first === "cl") {
    const idx = lower[1] === "live_stream" ? 99 : 1; // live_stream carries the id in ?v=
    const id = takeId(seg[idx], first + " url");
    return { kind: "video", videoId: id, notes };
  }

  if (first === "clip") return { kind: "clip", notes };
  if (first === "playlist" || first === "sets") return { kind: "playlist", notes };
  if (first === "results" || first === "search") return { kind: "search", notes };
  if (first === "feed") return { kind: "feed", notes };
  if (first === "channel" || first === "c") return { kind: "channel", notes };
  if (first === "user") return { kind: "user", notes };
  if (first === "community") return { kind: "post", notes };
  if (first === "about" || first === "trending" || first === "games" || first === "gaming" || first === "reporthostilecontent") {
    return { kind: "other", notes };
  }
  if (first.startsWith("@")) return { kind: "handle", notes };
  if (isYoutuBe) {
    const id = takeId(seg[0], "youtu.be link"); // youtu.be/<id>
    return { kind: "video", videoId: id, notes };
  }
  if (seg.length === 0) return { kind: "home", notes };
  return undefined;
}

function readParam(url: URL, names: string[]): string | undefined {
  for (const n of names) {
    const v = url.searchParams.get(n);
    if (v != null && v !== "") return v;
  }
  return undefined;
}

function fragmentStart(url: URL): number | undefined {
  const frag = url.hash.replace(/^#/, "");
  if (!frag) return undefined;
  const m = frag.match(/(?:^|[?&])t=([^&]+)/);
  return parseTimestamp(m ? m[1] : frag);
}

function playlistError(playlistId: string): TranscriptError {
  return new TranscriptError("NOT_A_VIDEO_URL", JSON.stringify(playlistId) + " is a playlist, not a video.", {
    hint: "Playlists have no transcript of their own. Open a video from the playlist and pass its URL (one watch?v= link at a time).",
    details: { playlistId },
  });
}

const KIND_LABEL: Record<string, string> = {
  playlist: "playlist",
  search: "search results page",
  feed: "subscription or library feed",
  channel: "channel page",
  user: "channel page",
  handle: "channel page",
  post: "community post",
  home: "YouTube home page",
  other: "YouTube page",
  unknown: "YouTube page",
  clip: "clip",
};

/** Parse an inner URL carried by another parameter; undefined when unusable. */
function tryNested(inner: string): ParsedTarget | undefined {
  try {
    const nested = parseYouTubeTarget(inner);
    return nested.videoId ? nested : undefined;
  } catch (err) {
    if (err instanceof TranscriptError && err.code === "INVALID_VIDEO_ID") throw err;
    return undefined;
  }
}

/** Resolve an absolute URL to a reference. */
function fromUrl(url: URL, original: string): ParsedTarget {
  const host = url.hostname.toLowerCase();
  if (!isYouTubeHost(host)) {
    throw new TranscriptError("NOT_A_VIDEO_URL", (host || original) + " is not a YouTube host.", {
      hint: "Transcripts are fetched from youtube.com and its subdomains, youtu.be and youtube-nocookie.com only.",
      details: { host },
    });
  }

  const route = routePath(url.pathname, host);
  const result: ParsedTarget = { kind: route?.kind ?? "unknown", host, notes: [...(route?.notes ?? [])] };
  const pathLower = url.pathname.toLowerCase();

  const playlistRaw = readParam(url, ["list", "p"]);
  if (playlistRaw) result.playlistId = playlistRaw.trim();

  const queryVideo = readParam(url, ["v", "video_id", "vid", "videoId"]);
  let candidate = route?.videoId ?? queryVideo ?? undefined;

  // /oembed?url=<encoded watch url>
  if (!candidate && /\/oembed(\/|$)/.test(pathLower)) {
    const inner = url.searchParams.get("url");
    if (inner) {
      const nested = tryNested(inner);
      if (nested) return { ...nested, host, notes: [...nested.notes, "Video id taken from the oEmbed url parameter."] };
    }
  }

  // /attribution_link?a=%2Fwatch%3Fv%3DID
  if (!candidate && /\/attribution_link/i.test(pathLower)) {
    const a = url.searchParams.get("a");
    if (a) {
      const absolute = /^https?:\/\//i.test(a) ? a : "https://www.youtube.com" + (a.startsWith("/") ? a : "/" + a);
      const nested = tryNested(absolute);
      if (nested) return { ...nested, host, notes: [...nested.notes, "Video id taken from the attribution link."] };
    }
  }

  if (candidate) {
    result.kind = "video";
    result.videoId = validateVideoId(candidate, queryVideo && candidate === queryVideo ? '"v" parameter' : "url");
  }

  const start = parseTimestamp(readParam(url, ["t", "start", "start_s", "t_start"])) ?? fragmentStart(url);
  const end = parseTimestamp(readParam(url, ["end", "end_s", "t_end"]));
  if (start != null) result.startSeconds = start;
  if (end != null) result.endSeconds = end;

  if (result.videoId) {
    result.canonicalUrl = "https://www.youtube.com/watch?v=" + result.videoId;
    if (result.playlistId) result.notes.push("Playlist parameter " + result.playlistId + " ignored: transcripts are fetched per video.");
    if (result.startSeconds) result.notes.push("URL pointed at " + result.startSeconds + "s; the transcript covers the whole video.");
    return result;
  }

  if (result.playlistId) throw playlistError(result.playlistId);
  if (result.kind === "clip") {
    throw new TranscriptError("NOT_A_VIDEO_URL", "That is a YouTube /clip/ link: it marks a range inside a video but carries no video id.", {
      hint: "Open the clip in YouTube and share the underlying video, or paste its watch URL.",
    });
  }
  throw new TranscriptError(
    "NOT_A_VIDEO_URL",
    JSON.stringify(original) + " points at a " + (KIND_LABEL[result.kind] ?? "YouTube page") + ", not a single video.",
    {
      hint: "A transcript needs one video. Paste a watch / shorts / live / embed URL or an 11-character video id.",
      details: { kind: result.kind, host },
    },
  );
}

/** Candidate URL spellings to try, most literal first. */
function candidateUrls(input: string): string[] {
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v && !out.includes(v)) out.push(v);
  };
  push(normalizeCandidateUrl(input));
  if (/%3[Ff]|%3[Dd]|%26/.test(input)) {
    let decoded = input;
    for (let i = 0; i < 2; i++) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        break;
      }
      push(normalizeCandidateUrl(decoded));
    }
    push(normalizeCandidateUrl(input.replace(/%3[Ff]/i, "?").replace(/%3[Dd]/gi, "=").replace(/%26/gi, "&")));
  }
  return out;
}

/**
 * Parse any YouTube reference.
 * @throws {TranscriptError} INVALID_URL, NOT_A_VIDEO_URL or INVALID_VIDEO_ID
 */
export function parseYouTubeTarget(rawInput: string): ParsedTarget {
  const input = cleanInput(rawInput);
  if (!input) {
    throw new TranscriptError("INVALID_URL", "No YouTube URL or video id was supplied.", {
      hint: "Pass a full URL such as https://www.youtube.com/watch?v=VIDEO_ID, or an 11-character video id.",
    });
  }

  // A bare id is the cheapest and most common case.
  if (VIDEO_ID_RE.test(input)) {
    return { kind: "video", videoId: input, canonicalUrl: "https://www.youtube.com/watch?v=" + input, notes: [] };
  }

  // Id-like tokens deserve an exact diagnosis rather than a generic parse error.
  if (/^(?:list=)?[A-Za-z0-9_-]+$/.test(input)) {
    const bare = input.replace(/^list=/i, "");
    if (PLAYLIST_ID_RE.test(bare)) throw playlistError(bare);
    validateVideoId(bare, "video id");
  }

  const failures: TranscriptError[] = [];
  for (const candidate of candidateUrls(input)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    try {
      return fromUrl(url, input);
    } catch (err) {
      if (!(err instanceof TranscriptError)) throw err;
      if (err.code === "INVALID_VIDEO_ID") throw err;
      failures.push(err);
    }
  }

  if (failures.length) throw failures[0]!;
  throw new TranscriptError("INVALID_URL", "Could not parse " + JSON.stringify(input) + " as a YouTube URL or video id.", {
    hint: "Expected something like https://www.youtube.com/watch?v=VIDEO_ID, https://youtu.be/VIDEO_ID, /shorts/VIDEO_ID, or a bare 11-character id.",
  });
}

/** Convenience: parse and require a video id. */
export function resolveVideoId(input: string): ParsedTarget {
  const target = parseYouTubeTarget(input);
  if (!target.videoId) {
    throw new TranscriptError("NOT_A_VIDEO_URL", "Could not find a video id in " + JSON.stringify(input) + ".");
  }
  return target;
}

export { VIDEO_ID_RE, PLAYLIST_ID_RE };
