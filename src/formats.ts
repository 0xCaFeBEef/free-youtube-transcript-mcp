/**
 * Caption payload parsing and output rendering.
 *
 * YouTube serves the same caption track in several wire formats. json3 is the
 * most faithful (real timings, no rolling duplicates) so it is preferred, but
 * srv3 / vtt / srv1 / ttml are parsed too: a track is sometimes only offered in
 * one format, and the yt-dlp fallback hands us whichever one it managed to get.
 */

import { TranscriptError } from "./errors.js";

export interface TranscriptSegment {
  /** Start offset in milliseconds. */
  startMs: number;
  /** End offset in milliseconds when known. */
  endMs?: number;
  text: string;
}

export type RawFormat = "json3" | "srv3" | "vtt" | "srv1" | "ttml";
export type OutputFormat = "text" | "srt" | "vtt" | "markdown" | "segments";

/** Decode the HTML/XML entities that appear inside caption payloads. */
export function decodeEntities(input: string): string {
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, String.fromCharCode(34))
    .replace(/&apos;/gi, String.fromCharCode(39))
    .replace(/&amp;/gi, "&");
}

/** Collapse one caption fragment into a single readable line. */
export function cleanText(input: string): string {
  return decodeEntities(input)
    .replace(/[\r\n]+/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Auto-generated tracks (especially VTT) roll: each cue repeats the previous
 * line with one more word. Fold those repeats so the text reads as prose.
 */
export function dedupeRollingCaptions(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev) {
      const a = normalizeForCompare(prev.text);
      const b = normalizeForCompare(text);
      if (a && b) {
        if (a === b) continue;
        if (b.length > a.length && b.startsWith(a) && a.length >= 3) {
          out[out.length - 1] = { ...prev, endMs: seg.endMs ?? seg.startMs + 1000, text };
          continue;
        }
        if (a.length > b.length && a.endsWith(b)) continue;
      }
    }
    out.push(seg);
  }
  return out;
}

/** Give every cue a sane end time (some formats omit duration). */
export function fillEnds(segs: TranscriptSegment[]): TranscriptSegment[] {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.endMs == null || s.endMs <= s.startMs) {
      const next = segs[i + 1];
      s.endMs = next ? Math.max(next.startMs, s.startMs + 250) : s.startMs + 2000;
    }
  }
  return segs;
}

// ---------------------------------------------------------------- json3 ---

export function parseJson3(body: string): TranscriptSegment[] {
  let data: any;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new TranscriptError("PARSE_ERROR", "Could not parse the caption payload (expected json3).", {
      cause: err,
      details: { head: body.slice(0, 120) },
    });
  }
  const events: any[] = Array.isArray(data && data.events) ? data.events : [];
  const segs: TranscriptSegment[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const parts: any[] = Array.isArray(ev.segs) ? ev.segs : [];
    const text = cleanText(parts.map((p) => (typeof p?.utf8 === "string" ? p.utf8 : "")).join(""));
    if (!text) continue;
    const startMs = Number(ev.tStartMs ?? ev.rsStartMs ?? 0) || 0;
    const dur = Number(ev.dDurationMs ?? 0);
    segs.push({ startMs, endMs: dur > 0 ? startMs + dur : undefined, text });
  }
  if (!segs.length) throw new TranscriptError("PARSE_ERROR", "Caption payload contained no speech (json3).");
  return fillEnds(segs);
}

// ----------------------------------------------------------------- srv3 ---

export function parseSrv3(body: string): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  const re = /<text([^>]*)>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const attrs = m[1] || "";
    const text = cleanText((m[2] || "").replace(/<[^>]+>/g, " "));
    if (!text) continue;
    const start = Number((attrs.match(/start="(-?[\d.]+)"/) || [])[1] ?? 0);
    const dur = Number((attrs.match(/dur="(-?[\d.]+)"/) || [])[1] ?? 0);
    segs.push({
      startMs: Math.round(start * 1000),
      endMs: dur > 0 ? Math.round((start + dur) * 1000) : undefined,
      text,
    });
  }
  if (!segs.length) throw new TranscriptError("PARSE_ERROR", "Caption payload contained no usable cues (srv3).");
  return fillEnds(segs);
}

// ----------------------------------------------------------------- srv1 ---

export function parseSrv1(body: string): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  const re = /<text([^>]*)>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const attrs = m[1] || "";
    const text = cleanText(m[2] || "");
    if (!text) continue;
    const start = Number((attrs.match(/start="(-?[\d.]+)"/) || [])[1] ?? 0);
    const dur = Number((attrs.match(/dur="(-?[\d.]+)"/) || [])[1] ?? 0);
    segs.push({
      startMs: Math.round(start * 1000),
      endMs: dur > 0 ? Math.round((start + dur) * 1000) : undefined,
      text,
    });
  }
  if (!segs.length) throw new TranscriptError("PARSE_ERROR", "Caption payload contained no usable cues (srv1).");
  return fillEnds(segs);
}

// ----------------------------------------------------------------- ttml ---

export function parseTtml(body: string): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  const re = /<p([^>]*)>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const attrs = m[1] || "";
    const text = cleanText((m[2] || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "));
    if (!text) continue;
    const begin = (attrs.match(/begin="([^"]+)"/) || [])[1];
    const end = (attrs.match(/end="([^"]+)"/) || [])[1];
    segs.push({ startMs: begin ? clockToMs(begin) : 0, endMs: end ? clockToMs(end) : undefined, text });
  }
  if (!segs.length) throw new TranscriptError("PARSE_ERROR", "Caption payload contained no usable cues (ttml).");
  return fillEnds(segs);
}

// ------------------------------------------------------------------ vtt ---

/** "00:01:02.500", "01:02.5" or a plain second count to milliseconds. */
export function clockToMs(clock: string): number {
  const c = String(clock).trim();
  const parts = c.split(":").map((p) => p.trim());
  if (parts.length >= 2 && parts.every((p) => /^\d+([.,]\d+)?$/.test(p))) {
    const secs = Number(parts.pop()!.replace(",", "."));
    let ms = Math.round(secs * 1000);
    let mult = 60;
    while (parts.length) ms += Number(parts.pop()) * mult * 1000, (mult *= 60);
    return ms;
  }
  const n = Number(c.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

export function parseVtt(body: string): TranscriptSegment[] {
  if (!/^WEBVTT/i.test(body.trim().slice(0, 200))) {
    throw new TranscriptError("PARSE_ERROR", "Caption payload is not WebVTT.");
  }
  const segs: TranscriptSegment[] = [];
  for (const block of body.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue; // header, NOTE block or orphan cue id
    const [left, right] = lines[timingIdx]!.split("-->");
    const startMs = clockToMs(((left || "").trim().split(/\s+/)[0]) || "0");
    const endMs = clockToMs(((right || "").trim().split(/\s+/)[0]) || "0");
    const rawText = lines
      .slice(timingIdx + 1)
      .join(" ")
      .replace(/<c[^>]*>/gi, "")
      .replace(/<[^>]+>/g, "");
    const text = cleanText(rawText);
    if (!text) continue;
    segs.push({ startMs, endMs: endMs > startMs ? endMs : undefined, text });
  }
  if (!segs.length) throw new TranscriptError("PARSE_ERROR", "WebVTT payload contained no usable cues.");
  return fillEnds(segs);
}

// ------------------------------------------------------------- detection ---

/** Detect the wire format from the payload itself. */
export function detectFormat(body: string): RawFormat {
  const head = String(body).trimStart().slice(0, 500);
  if (head.startsWith("{")) return "json3";
  if (/^WEBVTT/i.test(head)) return "vtt";
  if (/<tt[\s>]|xmlns[:=].*ttml/i.test(head)) return "ttml";
  // srv3 arrives as <timedtext format="3">, srv1 as <transcript><text ...>.
  if (/<timedtext[\s>]/i.test(head) || /format="3"/.test(head)) return "srv3";
  if (/<transcript[\s>]/i.test(head)) return "srv1";
  return "srv3";
}

/** Parse a payload, preferring the announced format and falling back to sniffing. */
export function parseTranscript(body: string, format?: RawFormat): TranscriptSegment[] {
  const text = String(body ?? "");
  if (!text.trim()) {
    throw new TranscriptError("PARSE_ERROR", "YouTube returned an empty caption payload.", {
      hint: "An empty payload usually means YouTube demanded a proof-of-origin token for this IP. Retry, or let the yt-dlp fallback handle it (YTA_YTDLP=always).",
      details: { requestedFormat: format ?? null },
    });
  }
  const order: RawFormat[] = format ? [format, detectFormat(text)] : [detectFormat(text)];
  let lastErr: unknown;
  for (const f of order) {
    try {
      const segs =
        f === "json3"
          ? parseJson3(text)
          : f === "vtt"
            ? parseVtt(text)
            : f === "srv1"
              ? parseSrv1(text)
              : f === "ttml"
                ? parseTtml(text)
                : parseSrv3(text);
      return segs;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof TranscriptError
    ? lastErr
    : new TranscriptError("PARSE_ERROR", "Unable to parse the caption payload.");
}

// ------------------------------------------------------------- rendering ---

export function formatClock(ms: number, style: "compact" | "srt" = "compact"): string {
  const total = Math.max(0, Math.round(ms || 0));
  const millis = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  if (style === "srt") return pad(h) + ":" + pad(m) + ":" + pad(s) + "," + pad(millis, 3);
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
}

export interface RenderOptions {
  format: OutputFormat;
  /** Prefix text lines with [mm:ss] (text output only). */
  timestamps?: boolean;
  /** Enables deep links in markdown output. */
  videoId?: string;
  maxChars?: number;
}

export interface RenderedTranscript {
  body: string;
  truncated: boolean;
  totalChars: number;
}

function applyLimit(body: string, maxChars?: number): RenderedTranscript {
  const total = body.length;
  if (maxChars && maxChars > 0 && total > maxChars) {
    const cut = body.slice(0, maxChars);
    const breakAt = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
    const clean = breakAt > maxChars * 0.5 ? cut.slice(0, breakAt + 1) : cut;
    return { body: clean, truncated: true, totalChars: total };
  }
  return { body, truncated: false, totalChars: total };
}

export function renderTranscript(segments: TranscriptSegment[], options: RenderOptions): RenderedTranscript {
  if (!segments.length) return { body: "", truncated: false, totalChars: 0 };
  const { format } = options;

  if (format === "segments") {
    return applyLimit(JSON.stringify(segments, null, 2), options.maxChars);
  }
  if (format === "srt" || format === "vtt") {
    const lines: string[] = format === "vtt" ? ["WEBVTT", ""] : [];
    segments.forEach((s, i) => {
      lines.push(String(i + 1));
      lines.push(formatClock(s.startMs, "srt") + " --> " + formatClock(s.endMs ?? s.startMs + 2000, "srt"));
      lines.push(s.text);
      lines.push("");
    });
    return applyLimit(lines.join("\n"), options.maxChars);
  }
  if (format === "markdown") {
    const lines = segments.map((s) => {
      const stamp = formatClock(s.startMs);
      const link = options.videoId
        ? "[" + stamp + "](https://youtu.be/" + options.videoId + "?t=" + Math.floor(s.startMs / 1000) + "s)"
        : stamp;
      return "- **" + link + "** " + s.text;
    });
    return applyLimit(lines.join("\n"), options.maxChars);
  }
  const body = segments
    .map((s) => (options.timestamps ? "[" + formatClock(s.startMs) + "] " + s.text : s.text))
    .join("\n");
  return applyLimit(body, options.maxChars);
}
