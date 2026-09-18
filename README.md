# youtube-transcript-mcp

An [MCP](https://modelcontextprotocol.io) server that returns the transcript of a YouTube video from
**any** YouTube URL — no API key, no browser, no OAuth. It knows that a meaningful
share of videos have no transcript at all, and says so precisely instead of failing
with a vague error or returning empty text.

- **Any reference shape.** watch URLs, `youtu.be`, Shorts, live, embeds, music,
  nocookie, mobile, legacy `/v/`, attribution links, oEmbed, URL-encoded links,
  Markdown links, prose around a link, or a bare 11-character id.
- **Honest failure.** `NO_TRANSCRIPT`, `TRANSCRIPT_GENERATING`, `PRIVATE_VIDEO`,
  `AGE_RESTRICTED`, `MEMBERS_ONLY`, `LIVE_ENDED`, `BOT_CHECK`, `RATE_LIMITED`,
  `LANGUAGE_UNAVAILABLE` … each with a hint and, where useful, the list of
  languages that do exist.
- **Resilient fetching.** Several InnerTube clients, the watch page, the transcript
  panel endpoint and an optional local `yt-dlp` fallback, tried in order, because a
  single endpoint gets you empty bodies or 429s depending on the IP you come from.
- **Language aware.** Preference lists, manual-vs-auto-generated awareness, and
  optional machine translation into a language the video does not offer.

## Install

```bash
git clone https://github.com/0xCaFeBEef/free-youtube-transcript-mcp.git youtube-transcript-mcp
cd youtube-transcript-mcp
pnpm install        # or: npm install
pnpm build
```

Requires Node.js 20+ (uses global `fetch`).

### Wire it into an MCP client

Claude Desktop, DSH, Cursor, or anything else that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "youtube-transcript": {
      "command": "node",
      "args": ["/absolute/path/to/youtube-transcript-mcp/dist/index.js"],
      "env": { "YTA_YTDLP": "auto" }
    }
  }
}
```

Or keep the source checked out and let the client run it directly with `tsx`:

```json
{
  "mcpServers": {
    "youtube-transcript": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/youtube-transcript-mcp/src/index.ts"]
    }
  }
}
```

### Try it from a terminal first

```bash
node dist/index.js --probe "https://youtu.be/dQw4w9WgXcQ"
node dist/index.js --probe "<url>" --lang hi --format markdown --timestamps
node dist/index.js --list-languages "<url>"
node dist/index.js --info "<url>"
node dist/index.js --help
```

## Tools

| Tool | What it does |
| --- | --- |
| `youtube_get_transcript` | The transcript. `url`, plus `languages`, `includeAutoCaptions`, `output`, `timestamps`, `maxChars`, `translateTo`. |
| `youtube_list_languages` | Every caption track: language, display name, whether it is auto-generated, plus YouTube's translation targets. |
| `youtube_video_info` | Title, author, duration, and whether captions exist at all. Cheap pre-flight for batch work. |
| `youtube_parse_url` | Offline parse: video id, playlist id, start offset, how it was recognised. Costs no request. |

`output` is one of `text` (default), `markdown` (timestamped bullets with deep links),
`segments` (JSON with millisecond timings), `srt` or `vtt`.

## URLs that work

All of these resolve to the same video:

```text
https://www.youtube.com/watch?v=VIDEO_ID
https://www.youtube.com/watch?v=VIDEO_ID&list=RDVIDEO_ID&index=3&t=42s&si=abc123
https://www.youtube.com/watch?feature=share&v=VIDEO_ID
https://www.youtube.com/watch/VIDEO_ID
https://www.youtube.com/v/VIDEO_ID      /vi/VIDEO_ID      /e/VIDEO_ID
https://www.youtube.com/embed/VIDEO_ID  (also youtube-nocookie.com)
https://www.youtube.com/shorts/VIDEO_ID
https://www.youtube.com/live/VIDEO_ID
https://youtu.be/VIDEO_ID?t=1m30s
https://m.youtube.com/watch?v=VIDEO_ID
https://music.youtube.com/watch?v=VIDEO_ID
https://www.youtube.co.uk/watch?v=VIDEO_ID
https://www.youtube.com/attribution_link?a=xyz&v=VIDEO_ID
https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DVIDEO_ID
https://www.youtube.com/watch%3Fv%3DVIDEO_ID          (double-encoded)
VIDEO_ID                                              (bare id)
<https://youtu.be/VIDEO_ID>   [title](https://youtu.be/VIDEO_ID)   here: https://youtu.be/VIDEO_ID!
```

Timestamps in `t`, `start`, `start_s` or `#t=` (accepting `42`, `42s`, `1m30s`,
`1h2m3s`, `01:30`, `1:02:03`) are parsed and reported, but a transcript is always for
the whole video — a start offset does not trim it.

Playlists, channels, `@`handles, search pages, feeds, community posts and `/clip/`
links are **not** one video, so they are rejected with an explanation rather than a
guess. A `list=` parameter travelling with a video URL is noted and ignored.

## When there is no transcript

This is a normal outcome, not an error condition to retry.

| Code | Meaning | Retry? |
| --- | --- | --- |
| `NO_TRANSCRIPT` | No captions exist: none uploaded, none generated. Or only auto-captions exist and you asked not to include them. | no |
| `TRANSCRIPT_GENERATING` | YouTube has queued auto-captions but not produced them yet (common hours after upload). | later |
| `VIDEO_NOT_FOUND` | Bad id, deleted, or never public. | no |
| `PRIVATE_VIDEO` / `MEMBERS_ONLY` | Requires the owner's or a member's session. | with cookies |
| `AGE_RESTRICTED` / `REGION_RESTRICTED` | Blocked for this session or region. | with cookies / proxy |
| `LIVE_ENDED` / `LIVE_NOT_STARTED` | Recording gone, or a scheduled premiere. 24/7 streams carry no captions. | no |
| `LANGUAGE_UNAVAILABLE` | Captions exist, but not in the language you asked for. `details.available` lists what does. | different language |
| `BOT_CHECK` / `RATE_LIMITED` | YouTube is throttling this IP (HTTP 403/429). Back off; cookies help. | yes, later |
| `PROVIDER_FAILED` | Every fetch path was refused. `attempts` shows what each one said. | yes |

Failures come back as `isError: true` with a JSON body:

```json
{
  "ok": false,
  "error": "None of the requested languages (xx) is available for this video.",
  "code": "LANGUAGE_UNAVAILABLE",
  "retryable": false,
  "hint": "Call youtube_list_languages to see what exists, or request one of those.",
  "details": {
    "requested": ["xx"],
    "available": [
      { "language": "en", "name": "English", "generated": false },
      { "language": "en", "name": "English (auto-generated)", "generated": true }
    ]
  }
}
```

## Languages

`languages` is a priority list: `["hi", "en"]` prefers Hindi and falls back to English,
noting the substitution in `notes`. Matching is exact tag first, then base language
(`en` matches `en-US`), and **human-written tracks always beat auto-generated ones** at
the same distance. `includeAutoCaptions: false` refuses speech-recognised tracks
outright — useful when wording accuracy matters.

`translateTo` asks YouTube to machine-translate. It works even when the video has no
track in the target language: the tool picks the original-language track and
translates that, and says so in `notes`.

## Configuration

All optional, all environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `YTA_HL` / `YTA_GL` | `en` / `US` | Interface language and region sent to YouTube; affects track display names. |
| `YTA_COOKIES` | – | Raw `Cookie` header, for age-restricted or your own private videos. |
| `YTA_COOKIES_FILE` | – | Netscape cookie file (the format browser extensions and yt-dlp emit); parsed for HTTP and passed to yt-dlp. |
| `YTA_TIMEOUT_MS` | `20000` | Timeout per HTTP request. |
| `YTA_RETRIES` | `2` | Retries for transport-level failures, with backoff. |
| `YTA_MAX_CHARS` | `200000` | Transcript cap per call; truncation is reported, not hidden. |
| `YTA_CACHE_TTL_MS` | `300000` | In-memory transcript cache lifetime. |
| `YTA_YTDLP` | `auto` | `auto` uses a local yt-dlp as fallback, `always` puts it first, `never` disables it. |
| `YTA_YTDLP_PATH` | `yt-dlp` | Path to the binary. |
| `YTA_PROVIDERS` | `innertube,watch-page,yt-dlp` | Override the provider order. |
| `YTA_USER_AGENT` | desktop Chrome UA | Sent on every request. |

## How it fetches, and why it sometimes cannot

1. **InnerTube `player` API** (Android, then iOS, MWEB, TV-embedded, web). The mobile
   clients still return ordinary caption URLs.
2. **The watch page**, whose `ytInitialPlayerResponse` also lists tracks — but those
   URLs carry a `exp=xpo,xpe` proof-of-origin experiment flag that makes
   `/api/timedtext` answer with an **empty body**. The flag is stripped before use.
3. **The `get_transcript` panel endpoint**, using the pre-encoded params the watch page
   embeds.
4. **Local `yt-dlp`**, if installed, as the most refusal-resistant path.

The first provider that lists tracks wins; if the download then fails, the providers
that were skipped are consulted for another copy of the same track. Payloads are
requested as `json3`, then `srv3`, then `vtt`, and parsed by sniffing when the answer
arrives in a different format than asked.

Practical consequences worth knowing:

- **Datacenter and shared IPs get throttled.** Empty 200-body caption responses and
  HTTP 429 are both anti-abuse responses, not bugs in the video. The tool backs off
  instead of retrying harder, and reports `RATE_LIMITED` / `BOT_CHECK`.
- **Cookies unlock access-limited videos** (`YTA_COOKIES` / `YTA_COOKIES_FILE`).
- **Auto-generated captions roll**: each cue can repeat the previous line. Repeats are
  folded before you see them.
- Music videos often carry placeholder captions (`[♪♪♪]`); those are real cues, kept.

## Development

```bash
pnpm test          # 40+ unit tests: URL parsing, wire formats, selection, rendering
pnpm test:live     # opt-in tests that hit YouTube (RUN_LIVE=1)
pnpm typecheck
```

## Notes

Unofficial API. Scraping transcripts can conflict with YouTube's Terms of Service;
use it considerately, cache responses, and do not hammer the endpoints. Captions are
the uploader's content — respect whatever licence applies to the video.
