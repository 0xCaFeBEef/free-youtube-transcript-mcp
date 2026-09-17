/**
 * A closed taxonomy of everything that can stop us from returning a transcript.
 *
 * The distinction matters: "this video has no transcript" and "YouTube refused
 * this request right now" need completely different follow-ups, so every failure
 * leaves the caller with a machine-readable code, a human sentence, whether a
 * retry could help, and (where useful) what to try instead.
 */

export const ERROR_CODES = [
  // ---- input problems ----------------------------------------------------
  'INVALID_URL',
  'INVALID_VIDEO_ID',
  'NOT_A_VIDEO_URL',
  // ---- the video itself --------------------------------------------------
  'VIDEO_NOT_FOUND',
  'VIDEO_UNAVAILABLE',
  'PRIVATE_VIDEO',
  'MEMBERS_ONLY',
  'AGE_RESTRICTED',
  'REGION_RESTRICTED',
  'LIVE_NOT_STARTED',
  'LIVE_ENDED',
  // ---- transcript availability ------------------------------------------
  'NO_TRANSCRIPT',
  'TRANSCRIPT_GENERATING',
  'LANGUAGE_UNAVAILABLE',
  // ---- access / transport ----------------------------------------------
  'BOT_CHECK',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'PARSE_ERROR',
  'PROVIDER_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface TranscriptErrorOptions {
  retryable?: boolean;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** One provider attempt, reported back alongside failures. */
export interface AttemptLog {
  provider: string;
  error: string;
  code?: string;
}

/** Default retryability per code; callers can override. */
const RETRYABLE: Partial<Record<ErrorCode, boolean>> = {
  BOT_CHECK: true,
  RATE_LIMITED: true,
  NETWORK_ERROR: true,
  TIMEOUT: true,
  PROVIDER_FAILED: true,
  TRANSCRIPT_GENERATING: true,
};

export class TranscriptError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  /** Which providers were attempted, for transparency in tool output. */
  attempts?: AttemptLog[];

  constructor(code: ErrorCode, message: string, options: TranscriptErrorOptions = {}) {
    super(message, options.cause != null ? { cause: options.cause } : undefined);
    this.name = 'TranscriptError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE[code] ?? false;
    this.hint = options.hint;
    this.details = options.details;
  }

  /** Attach the provider attempt log and return self for chaining. */
  withAttempts(attempts: AttemptLog[]): this {
    this.attempts = attempts;
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      ok: false,
      error: this.message,
      code: this.code,
      retryable: this.retryable,
    };
    if (this.hint) out.hint = this.hint;
    if (this.details && Object.keys(this.details).length) out.details = this.details;
    if (this.attempts?.length) out.attempts = this.attempts;
    return out;
  }
}

/** Narrow helper for catch blocks. */
export function isTranscriptError(err: unknown): err is TranscriptError {
  return err instanceof TranscriptError;
}

/** Anything thrown that is not ours becomes an INTERNAL error, preserving text. */
export function toTranscriptError(err: unknown): TranscriptError {
  if (err instanceof TranscriptError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || /aborted|timed out/i.test(err.message)) {
      return new TranscriptError('TIMEOUT', `The request to YouTube timed out (${err.message}).`, { cause: err });
    }
    if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|fetch failed|network/i.test(err.message)) {
      return new TranscriptError('NETWORK_ERROR', `Network error contacting YouTube: ${err.message}`, { cause: err });
    }
    return new TranscriptError('INTERNAL', err.message, { cause: err });
  }
  return new TranscriptError('INTERNAL', String(err));
}

interface PlayabilityInput {
  status?: string;
  reason?: string;
  errorScreenReason?: string;
  isLive?: boolean;
  liveBroadcastContent?: string;
}

/**
 * Translate a YouTube playabilityStatus into our taxonomy.
 * Returns undefined when the video is playable.
 */
export function classifyPlayability(input: PlayabilityInput): {
  code: ErrorCode;
  message: string;
  hint?: string;
} | undefined {
  const status = (input.status ?? '').toUpperCase();
  const reason = (input.reason || input.errorScreenReason || '').trim();
  const r = reason.toLowerCase();

  if (status === 'LIVE_STREAM_OFFLINE') {
    return {
      code: 'LIVE_NOT_STARTED',
      message: reason || 'This video is a scheduled live stream that has not started yet.',
      hint: 'Live streams only gain a transcript once the broadcast, or its recording, is available.',
    };
  }
  if (!status || status === 'OK' || status === 'LIVE' || status === 'LIVE_ONGOING') return undefined;

  if (/not a bot|unusual traffic|verify you are human/i.test(r)) {
    return {
      code: 'BOT_CHECK',
      message: reason || 'YouTube asked for a sign-in before serving this video.',
      hint: 'YouTube is throttling this IP address. Retry later, or supply cookies from a signed-in browser (YTA_COOKIES / YTA_COOKIES_FILE).',
    };
  }
  if (/age|under ?18/i.test(r)) {
    return {
      code: 'AGE_RESTRICTED',
      message: reason || 'This video has age restrictions.',
      hint: 'Age-restricted videos need a verified signed-in session: set YTA_COOKIES with cookies from a browser that is signed in.',
    };
  }
  if (/member|membership|join this channel/i.test(r)) {
    return {
      code: 'MEMBERS_ONLY',
      message: reason || 'This video is for channel members only.',
      hint: 'Only signed-in channel members can load this video, so its transcript cannot be fetched anonymously.',
    };
  }
  if (status === 'LOGIN_REQUIRED' || /private/i.test(r)) {
    return {
      code: 'PRIVATE_VIDEO',
      message: reason || 'This video is private.',
      hint: 'Private videos require the owner to be signed in; set YTA_COOKIES if you own the video.',
    };
  }
  if (/country|region|not available in your country/i.test(r)) {
    return {
      code: 'REGION_RESTRICTED',
      message: reason || 'This video is not available in the current region.',
      hint: 'Fetch from an allowed region (proxy) and try again.',
    };
  }
  if (/live stream recording|broadcast|premiere/i.test(r) || input.isLive) {
    return {
      code: 'LIVE_ENDED',
      message: reason || 'The live stream recording is not available.',
      hint: input.isLive
        ? 'Ongoing 24/7 streams carry no caption track; transcripts exist only for recorded broadcasts with captions.'
        : undefined,
    };
  }
  if (status === 'ERROR') {
    return {
      code: 'VIDEO_NOT_FOUND',
      message: reason || 'Video unavailable',
      hint: 'The id may be wrong, deleted, or never public. Re-check the URL.',
    };
  }
  if (status === 'UNPLUGGED') return undefined;
  return {
    code: 'VIDEO_UNAVAILABLE',
    message: reason || `Video is not playable (playabilityStatus: ${status}).`,
    hint: 'YouTube refused this video; no change to the transcript request will alter that.',
  };
}
