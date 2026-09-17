/**
 * Wire-format parsing and rendering tests, using trimmed real payloads.
 */
import { describe, expect, it } from "vitest";

import {
  clockToMs,
  dedupeRollingCaptions,
  detectFormat,
  formatClock,
  parseJson3,
  parseSrv1,
  parseSrv3,
  parseTranscript,
  parseTtml,
  parseVtt,
  renderTranscript,
  cleanText,
} from "../src/formats.js";
import { TranscriptError } from "../src/errors.js";

const JSON3 = JSON.stringify({
  wireMagic: "pb3",
  events: [
    { tStartMs: 1360, dDurationMs: 1680, segs: [{ utf8: "[♪♪♪]" }] },
    { tStartMs: 18640, dDurationMs: 3240, segs: [{ utf8: "We" }, { utf8: " are" }, { utf8: " no strangers" }] },
    { tStartMs: 22640, dDurationMs: 2000, segs: [{ utf8: "\n" }] },
    { tStartMs: 24640, dDurationMs: 2000, segs: [{ utf8: "Tom & Jerry &lt;3 &#39;quotes&#39;" }] },
  ],
});

const SRV3 =
  '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><text start="1.36" dur="1.68">' +
  '[&#9834;&#9834;&#9834;]</text><text start="18.64" dur="3.24"><span start="18.64">Never</span>' +
  '<span start="19.2"> gonna</span></text></timedtext>';

const SRV1 =
  '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="1.5" dur="2">Hello there</text>' +
  '<text start="4" dur="1.5"> &amp; goodbye</text></transcript>';

const VTT = [
  "WEBVTT",
  "Kind: captions",
  "Language: en",
  "",
  "00:00:01.360 --> 00:00:03.040 align:start position:0%",
  "[♪♪♪]",
  "",
  "1",
  "00:00:18.640 --> 00:00:21.879 align:start position:0%",
  "Never <00:00:19.200><c> gonna</c> give<c> you</c> up",
  "",
  "NOTE this block should be ignored",
  "",
  "2",
  "00:00:22.000 --> 00:00:24.000",
  "Line one",
  "line two",
  "",
].join("\n");

const TTML =
  '<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/2006/10/ttml"><body><div>' +
  '<p begin="00:00:01.360" end="00:00:03.040">Never gonna</p>' +
  '<p begin="00:00:03.040" end="00:00:05.000">give you up<br/>again</p>' +
  "</div></body></tt>";

describe("json3", () => {
  it("joins word segments into cue text", () => {
    const segs = parseJson3(JSON3);
    expect(segs.map((s) => s.text)).toEqual(["[♪♪♪]", "We are no strangers", "Tom & Jerry <3 'quotes'"]);
  });
  it("keeps timings and fills a missing duration", () => {
    const segs = parseJson3(JSON3);
    expect(segs[0]).toMatchObject({ startMs: 1360, endMs: 3040 });
    expect(segs[1]!.endMs).toBe(21880);
  });
  it("rejects an unusable payload", () => {
    expect(() => parseJson3(JSON.stringify({ events: [] }))).toThrow(TranscriptError);
  });
});

describe("srv3 and srv1", () => {
  it("parses srv3 spans into one cue", () => {
    const segs = parseSrv3(SRV3);
    expect(segs).toHaveLength(2);
    expect(segs[1]!.text).toBe("Never gonna");
    expect(segs[1]!.startMs).toBe(18640);
  });
  it("parses srv1 and decodes entities", () => {
    const segs = parseSrv1(SRV1);
    expect(segs.map((s) => s.text)).toEqual(["Hello there", "& goodbye"]);
  });
});

describe("vtt", () => {
  it("skips headers and NOTE blocks, strips inline timing tags", () => {
    const segs = parseVtt(VTT);
    expect(segs.map((s) => s.text)).toEqual(["[♪♪♪]", "Never gonna give you up", "Line one line two"]);
    expect(segs[0]!.startMs).toBe(1360);
  });
  it("refuses a non-VTT payload", () => {
    expect(() => parseVtt("not a subtitle file")).toThrow(TranscriptError);
  });
});

describe("ttml", () => {
  it("parses p elements with clock attributes", () => {
    const segs = parseTtml(TTML);
    expect(segs).toHaveLength(2);
    expect(segs[1]!.text).toBe("give you up again");
  });
});

describe("format sniffing", () => {
  it("detects each wire format", () => {
    expect(detectFormat(JSON3)).toBe("json3");
    expect(detectFormat(VTT)).toBe("vtt");
    expect(detectFormat(SRV3)).toBe("srv3");
    expect(detectFormat(SRV1)).toBe("srv1");
    expect(detectFormat(TTML)).toBe("ttml");
  });
  it("parses without being told the format", () => {
    expect(parseTranscript(SRV3)[0]!.text).toBe("[♪♪♪]");
    expect(parseTranscript(VTT)[0]!.text).toBe("[♪♪♪]");
  });
  it("explains an empty body instead of crashing", () => {
    try {
      parseTranscript("   ", "json3");
      throw new Error("should throw");
    } catch (err) {
      expect((err as TranscriptError).code).toBe("PARSE_ERROR");
      expect((err as TranscriptError).hint).toMatch(/proof-of-origin/);
    }
  });
});

describe("rolling-caption de-duplication", () => {
  it("collapses cumulative auto-caption repeats", () => {
    const segs = [
      { startMs: 0, text: "hello there" },
      { startMs: 1000, text: "hello there how are you" },
      { startMs: 2500, text: "how are you" },
      { startMs: 4000, text: "completely different" },
    ];
    expect(dedupeRollingCaptions(segs).map((s) => s.text)).toEqual(["hello there how are you", "completely different"]);
  });
});

describe("rendering", () => {
  const segs = [
    { startMs: 0, endMs: 2000, text: "First line" },
    { startMs: 63000, endMs: 65000, text: "Second line" },
  ];
  it("renders plain text and timestamps", () => {
    expect(renderTranscript(segs, { format: "text" }).body).toBe("First line\nSecond line");
    expect(renderTranscript(segs, { format: "text", timestamps: true }).body).toBe("[0:00] First line\n[1:03] Second line");
  });
  it("renders srt and vtt", () => {
    const srt = renderTranscript(segs, { format: "srt" }).body;
    expect(srt).toContain("00:00:00,000 --> 00:00:02,000");
    expect(srt).toContain("00:01:03,000 --> 00:01:05,000");
    const vtt = renderTranscript(segs, { format: "vtt" }).body;
    expect(vtt.startsWith("WEBVTT")).toBe(true);
  });
  it("renders markdown deep links", () => {
    const md = renderTranscript(segs, { format: "markdown", videoId: "dQw4w9WgXcQ" }).body;
    expect(md).toContain("[0:00](https://youtu.be/dQw4w9WgXcQ?t=0s)");
  });
  it("truncates on a boundary and reports it", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 5000, text: "line " + i })).map((s) => ({ ...s, text: s.text + " ".repeat(30) }));
    const out = renderTranscript(long, { format: "text", maxChars: 200 });
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBeGreaterThan(200);
    expect(out.body.length).toBeLessThan(260);
  });
});

describe("clock helpers", () => {
  it("converts vtt clocks", () => {
    expect(clockToMs("00:01:02.500")).toBe(62500);
    expect(clockToMs("01:02")).toBe(62000);
    expect(clockToMs("62.5")).toBe(62500);
    expect(clockToMs("garbage")).toBe(0);
  });
  it("formats clocks", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(62_500)).toBe("1:02");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(62_500, "srt")).toBe("00:01:02,500");
  });
  it("cleans text", () => {
    expect(cleanText("  a&nbsp;b \n c ")).toBe("a b c");
    expect(cleanText("&amp;amp;")).toBe("&amp;");
  });
});
