/**
 * Caption-track model and language selection.
 *
 * A track is "manual" when a human wrote it and "generated" when YouTube ran
 * speech recognition (kind === "asr"). Callers care about the difference: auto
 * tracks have no punctuation, mishear names and drift badly on music.
 */

import { TranscriptError } from "./errors.js";

export type TrackSource = "innertube" | "watch-page" | "get-transcript" | "yt-dlp";

export interface CaptionTrack {
  /** BCP-47-ish code as YouTube labels it, e.g. "en", "pt-BR", "zh-Hans". */
  languageCode: string;
  /** Set when this track is YouTube's machine translation of another one.
   *  languageCode stays the source language so retries still match siblings. */
  translatedTo?: string;
  /** Human name as YouTube displayed it (depends on the requested hl). */
  displayName: string;
  /** True for speech-recognition ("asr") tracks. */
  isGenerated: boolean;
  /** True when YouTube marks this as the original spoken language. */
  isOriginal?: boolean;
  /** Signed URL that returns the caption payload. */
  baseUrl: string;
  /** Whether YouTube offers this track as a translation source. */
  isTranslatable: boolean;
  source: TrackSource;
  /** Opaque track id when the player supplied one. */
  trackId?: string;
}

export interface TranslationLanguage {
  languageCode: string;
  displayName: string;
}

export interface VideoDetails {
  videoId?: string;
  title?: string;
  author?: string;
  lengthSeconds?: number;
  isLive?: boolean;
  isCaptionable?: boolean;
}

export interface TrackSet {
  tracks: CaptionTrack[];
  translationLanguages: TranslationLanguage[];
  /** YouTube can machine-translate the captions for this video. */
  autoTranslationEnabled: boolean;
  details: VideoDetails;
  provider: string;
}

function nameOf(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.simpleText) return String(node.simpleText);
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => r?.text ?? "").join("");
  return "";
}

const GENERATED_HINTS = /(auto(?:matically)? generated|asr|created by youtube)/i;

/** Normalize a player response captionTracks array into our track model. */
export function tracksFromPlayer(player: any, source: TrackSource): TrackSet {
  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const raw: any[] = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [];

  const audioLabel = (index: any): string | undefined => {
    const list = Array.isArray(renderer?.audioTracks) ? renderer.audioTracks : [];
    const hit = list.find((a: any) => String(a?.trackIndex) === String(index));
    return hit ? nameOf(hit.displayName) : undefined;
  };

  const tracks: CaptionTrack[] = raw
    .map((t) => {
      const kind = String(t?.kind ?? "").toLowerCase();
      const explicit = nameOf(t?.name);
      const languageCode = String(t?.languageCode ?? (String(t?.vssId ?? "").replace(/^\./, "") || "und"));
      const isGenerated = kind === "asr" || GENERATED_HINTS.test(explicit + " " + String(t?.nameId ?? ""));
      return {
        languageCode,
        displayName: explicit || audioLabel(t?.trackIndex) || languageCode,
        isGenerated,
        isOriginal: t?.isOriginal === true || /-original$/.test(String(t?.captionTrackId ?? "")),
        baseUrl: String(t?.baseUrl ?? ""),
        isTranslatable: t?.isTranslation === true || renderer?.translationLanguages?.length > 0,
        source,
        trackId: t?.captionTrackId ?? t?.nameId ?? undefined,
      };
    })
    .filter((t) => t.baseUrl);

  const translationLanguages: TranslationLanguage[] = (
    Array.isArray(renderer?.translationLanguages) ? renderer.translationLanguages : []
  )
    .map((l: any) => ({
      languageCode: String(l?.languageCode ?? ""),
      displayName: nameOf(l?.language) || String(l?.languageCode ?? ""),
    }))
    .filter((l: TranslationLanguage) => l.languageCode);

  return {
    tracks,
    translationLanguages,
    autoTranslationEnabled: renderer?.enableTranslate === true || translationLanguages.length > 0,
    details: detailsFromPlayer(player),
    provider: source,
  };
}

export function detailsFromPlayer(player: any): VideoDetails {
  const v = player?.videoDetails ?? {};
  return {
    videoId: v.videoId,
    title: typeof v.title === "string" ? v.title : undefined,
    author: typeof v.author === "string" ? v.author : undefined,
    lengthSeconds: v.lengthSeconds != null ? Number(v.lengthSeconds) : undefined,
    isLive: v.isLiveContent === true,
    isCaptionable: Boolean(player?.captions),
  };
}

/** "en-US" -> { full: "en-us", base: "en" } */
function normalizeTag(tag: string): { full: string; base: string } {
  const full = String(tag).trim().toLowerCase().replace(/_/g, "-");
  return { full, base: full.split("-")[0] ?? full };
}

export interface TrackMatch {
  track: CaptionTrack;
  /** 0 exact tag, 1 same base language, 2 loose prefix match. */
  distance: number;
}

/** Every track matching a requested language, best first. */
export function matchesFor(tracks: CaptionTrack[], requested: string): TrackMatch[] {
  const want = normalizeTag(requested);
  const out: TrackMatch[] = [];
  for (const track of tracks) {
    const have = normalizeTag(track.languageCode);
    const name = track.displayName.toLowerCase();
    let distance = Number.POSITIVE_INFINITY;
    if (have.full === want.full) distance = 0;
    else if (have.base === want.base) distance = 1;
    else if (name === want.full || name === want.base || name.startsWith(want.base + "-")) distance = 1;
    else if (have.full.startsWith(want.base + "-") || have.base.startsWith(want.base + "-")) distance = 2;
    if (Number.isFinite(distance)) out.push({ track, distance });
  }
  return out.sort(
    (a, b) => a.distance - b.distance || Number(a.track.isGenerated) - Number(b.track.isGenerated),
  );
}

export interface SelectionPrefs {
  /** Language preferences in priority order, e.g. ["en", "hi"]. */
  languages: string[];
  /** Allow speech-recognised tracks (default true). */
  allowAutoGenerated?: boolean;
  /**
   * When no preference matches, fall back to any track rather than failing.
   * Used for machine translation, where the point is to reach a language the
   * video does not offer as a track.
   */
  fallbackToAny?: boolean;
}

export interface SelectedTrack {
  track: CaptionTrack;
  /** The preference entry that matched. */
  requested: string;
  distance: number;
  /** Human-readable caveats, e.g. "fell back to auto-generated captions". */
  notes: string[];
}

function availableSummary(tracks: CaptionTrack[]): { language: string; name: string; generated: boolean }[] {
  return tracks.map((t) => ({ language: t.languageCode, name: t.displayName, generated: t.isGenerated }));
}

/**
 * Choose the best track for a list of language preferences.
 * Manual tracks always beat auto-generated ones at the same language distance.
 */
export function selectTrack(tracks: CaptionTrack[], prefs: SelectionPrefs): SelectedTrack {
  if (!tracks.length) {
    throw new TranscriptError("NO_TRANSCRIPT", "This video has no captions of any kind.", {
      hint: "The uploader added no subtitles and YouTube generated none. No retry will change that.",
      details: { available: [] },
    });
  }
  const allowAuto = prefs.allowAutoGenerated !== false;
  const candidates = allowAuto ? tracks : tracks.filter((t) => !t.isGenerated);
  if (!candidates.length) {
    throw new TranscriptError("NO_TRANSCRIPT", "This video only has auto-generated captions, and auto-generated captions were excluded.", {
      hint: "Retry with includeAutoCaptions=true to accept the speech-recognised transcript.",
      details: { available: availableSummary(tracks) },
    });
  }

  const ordered: SelectedTrack[] = [];
  for (const language of prefs.languages) {
    if (!language) continue;
    for (const match of matchesFor(candidates, language)) {
      const notes: string[] = [];
      if (match.distance === 1) notes.push("No exact track for " + language + "; used " + match.track.languageCode + ".");
      if (match.distance === 2) notes.push("Loosely matched " + match.track.languageCode + " for " + language + ".");
      if (match.track.isGenerated) notes.push("Auto-generated captions: wording and punctuation may be imperfect.");
      ordered.push({ track: match.track, requested: language, distance: match.distance, notes });
    }
  }

  if (ordered.length) {
    ordered.sort(
      (a, b) =>
        a.distance - b.distance ||
        Number(a.track.isGenerated) - Number(b.track.isGenerated) ||
        Number(!a.track.isOriginal) - Number(!b.track.isOriginal),
    );
    return ordered[0]!;
  }

  if (prefs.fallbackToAny) {
    const any = [...candidates].sort(
      (a, b) => Number(a.isGenerated) - Number(b.isGenerated) || Number(!a.isOriginal) - Number(!b.isOriginal),
    )[0]!;
    return {
      track: any,
      requested: prefs.languages[0] ?? any.languageCode,
      distance: 99,
      notes: [
        "No track in the requested language (" +
          prefs.languages.join(", ") +
          "); started from " +
          any.languageCode +
          " instead.",
      ],
    };
  }

  throw new TranscriptError(
    "LANGUAGE_UNAVAILABLE",
    "None of the requested languages (" + prefs.languages.join(", ") + ") is available for this video.",
    {
      hint: "Call youtube_list_languages to see what exists, or request one of those.",
      details: { requested: prefs.languages, available: availableSummary(tracks) },
    },
  );
}

/** Merge several track sets (from different providers) keeping the first seen. */
export function mergeTrackSets(sets: TrackSet[]): TrackSet | undefined {
  const seen = new Map<string, CaptionTrack>();
  let base: TrackSet | undefined;
  for (const set of sets) {
    base = base ?? set;
    for (const track of set.tracks) {
      const key = track.languageCode.toLowerCase() + "|" + (track.isGenerated ? "asr" : "manual");
      if (!seen.has(key)) seen.set(key, track);
    }
  }
  if (!base) return undefined;
  return { ...base, tracks: [...seen.values()] };
}
