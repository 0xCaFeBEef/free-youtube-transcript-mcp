/**
 * URL parsing tests. Every case is a shape a user has actually pasted into a
 * transcript tool at some point.
 */
import { describe, expect, it } from "vitest";

import { parseTimestamp, parseYouTubeTarget, resolveVideoId, validateVideoId } from "../src/url.js";
import { TranscriptError } from "../src/errors.js";

const ID = "dQw4w9WgXcQ";
const ID2 = "3tX9j-EJ_7k"; // hyphen and underscore members of the id alphabet

const idOf = (input: string): string | undefined => parseYouTubeTarget(input).videoId;

function expectCode(input: string, code: string): void {
  try {
    parseYouTubeTarget(input);
    throw new Error("expected " + code + " for " + input);
  } catch (err) {
    expect(err).toBeInstanceOf(TranscriptError);
    expect((err as TranscriptError).code).toBe(code);
  }
}

describe("watch URLs", () => {
  it("reads the v parameter", () => {
    expect(idOf("https://www.youtube.com/watch?v=" + ID)).toBe(ID);
    expect(idOf("http://youtube.com/watch?v=" + ID)).toBe(ID);
    expect(idOf("https://m.youtube.com/watch?v=" + ID)).toBe(ID);
    expect(idOf("https://music.youtube.com/watch?v=" + ID + "&feature=share")).toBe(ID);
    expect(idOf("https://www.youtube.co.uk/watch?v=" + ID)).toBe(ID);
  });

  it("survives the parameter soup after a real share", () => {
    expect(
      idOf(
        "https://www.youtube.com/watch?v=" + ID + "&list=RD" + ID + "&index=2&t=42s&si=abcdef&pp=AgI&ab_channel=x&feature=share",
      ),
    ).toBe(ID);
  });

  it("handles query-first and legacy path routes", () => {
    expect(idOf("https://www.youtube.com/watch?feature=share&v=" + ID)).toBe(ID);
    expect(idOf("https://www.youtube.com/watch/" + ID)).toBe(ID);
    expect(idOf("https://www.youtube.com/v/" + ID)).toBe(ID);
    expect(idOf("https://www.youtube.com/vi/" + ID)).toBe(ID);
    expect(idOf("https://www.youtube.com/e/" + ID)).toBe(ID);
    expect(idOf("https://www.youtube.com/get_video_info?video_id=" + ID)).toBe(ID);
  });

  it("keeps the path id when both path and v are present", () => {
    expect(idOf("https://www.youtube.com/watch/" + ID2 + "?v=" + ID)).toBe(ID2);
  });
});

describe("embed, shorts, live, short links", () => {
  it("reads every player path", () => {
    expect(idOf("https://www.youtube.com/embed/" + ID)).toBe(ID);
    expect(idOf("https://www.youtube-nocookie.com/embed/" + ID + "?start=10")).toBe(ID);
    expect(idOf("https://www.youtube.com/embed/live_stream?channel=UC1234&v=" + ID)).toBe(ID);
    expect(idOf("https://www.youtube.com/shorts/" + ID)).toBe(ID);
    expect(idOf("https://youtube.com/shorts/" + ID + "?feature=share&si=xyz")).toBe(ID);
    expect(idOf("https://www.youtube.com/live/" + ID + "?feature=share")).toBe(ID);
    expect(idOf("https://m.youtube.com/watch?v=" + ID + "&fbclid=abc")).toBe(ID);
  });

  it("reads youtu.be links with and without offsets", () => {
    expect(idOf("https://youtu.be/" + ID)).toBe(ID);
    expect(idOf("https://youtu.be/" + ID + "?t=90s")).toBe(ID);
    expect(idOf("https://youtu.be/" + ID + "?si=O6zKZ1pQFAKQxfxO&t=1m2s")).toBe(ID);
    expect(parseYouTubeTarget("https://youtu.be/" + ID + "?t=1m2s").startSeconds).toBe(62);
  });

  it("unwraps attribution and oEmbed indirection", () => {
    expect(idOf("https://www.youtube.com/attribution_link?a=xyz&v=" + ID)).toBe(ID);
    expect(idOf("https://www.youtube.com/attribution_link?a=%2Fwatch%3Fv%3D" + ID + "&feature=share")).toBe(ID);
    expect(idOf("https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D" + ID + "&format=json")).toBe(ID);
  });
});

describe("raw ids and messy input", () => {
  it("accepts a bare id", () => {
    expect(idOf(ID)).toBe(ID);
    expect(idOf(ID2)).toBe(ID2);
    expect(idOf("Uk1tZlFONZc")).toBe("Uk1tZlFONZc");
  });

  it("cleans markdown, quotes, angle brackets and prose", () => {
    expect(idOf("<https://youtu.be/" + ID + ">")).toBe(ID);
    expect(idOf("'" + ID + "'")).toBe(ID);
    expect(idOf("[Watch this](https://www.youtube.com/watch?v=" + ID + ")")).toBe(ID);
    expect(idOf("check it out: https://youtu.be/" + ID + "!")).toBe(ID);
    expect(idOf("  https://www.youtube.com/watch?v=" + ID + "  ")).toBe(ID);
    expect(idOf("https://www.youtube.com/watch?v=" + ID + ".")).toBe(ID);
  });

  it("accepts protocol-less and uppercase forms", () => {
    expect(idOf("youtube.com/watch?v=" + ID)).toBe(ID);
    expect(idOf("www.youtu.be/" + ID)).toBe(ID);
    expect(idOf("HTTPS://WWW.YOUTUBE.COM/watch?v=" + ID)).toBe(ID);
    expect(idOf("//www.youtube.com/watch?v=" + ID)).toBe(ID);
  });

  it("decodes double-encoded watch urls", () => {
    expect(idOf("https://www.youtube.com/watch%3Fv%3D" + ID)).toBe(ID);
  });
});

describe("timestamps", () => {
  it("parses every clock shape YouTube emits", () => {
    expect(parseTimestamp("90")).toBe(90);
    expect(parseTimestamp("90s")).toBe(90);
    expect(parseTimestamp("1m30s")).toBe(90);
    expect(parseTimestamp("1h2m3s")).toBe(3723);
    expect(parseTimestamp("01:30")).toBe(90);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("42.7")).toBe(42);
    expect(parseTimestamp("nope")).toBeUndefined();
    expect(parseTimestamp(null)).toBeUndefined();
  });

  it("extracts offsets from query and fragment", () => {
    expect(parseYouTubeTarget("https://youtu.be/" + ID + "?t=1h2m3s").startSeconds).toBe(3723);
    expect(parseYouTubeTarget("https://www.youtube.com/watch?v=" + ID + "&t=42").startSeconds).toBe(42);
    expect(parseYouTubeTarget("https://www.youtube.com/watch?v=" + ID + "#t=120").startSeconds).toBe(120);
    expect(parseYouTubeTarget("https://www.youtube.com/watch?v=" + ID + "&start=10&end=20").endSeconds).toBe(20);
  });
});

describe("things that are not one video", () => {
  it("rejects playlists but keeps the playlist id in details", () => {
    try {
      parseYouTubeTarget("https://www.youtube.com/playlist?list=PLbcLMApnBcdFL5lG2u2YpFpgIPWdovbBU");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as TranscriptError).code).toBe("NOT_A_VIDEO_URL");
      expect(String((err as TranscriptError).details?.playlistId)).toMatch(/^PL/);
    }
    expectCode("PLbcLMApnBcdFL5lG2u2YpFpgIPWdovbBU", "NOT_A_VIDEO_URL");
  });

  it("keeps the video when a playlist travels with it", () => {
    const parsed = parseYouTubeTarget("https://www.youtube.com/watch?v=" + ID + "&list=RD" + ID);
    expect(parsed.videoId).toBe(ID);
    expect(parsed.playlistId).toMatch(/^RD/);
    expect(parsed.notes.join(" ")).toMatch(/Playlist/);
  });

  it("explains channel, search, feed, community and clip links", () => {
    for (const url of [
      "https://www.youtube.com/@cocompander",
      "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw",
      "https://www.youtube.com/user/pewdiepie",
      "https://www.youtube.com/results?search_query=cats",
      "https://www.youtube.com/feed/trending",
      "https://www.youtube.com/community",
      "https://www.youtube.com/clip/Ugkx-random-clip-id",
      "https://www.youtube.com",
    ]) {
      expectCode(url, "NOT_A_VIDEO_URL");
    }
  });

  it("rejects non-YouTube hosts and empty input", () => {
    expectCode("https://vimeo.com/76979871", "NOT_A_VIDEO_URL");
    expectCode("https://www.youtubekicks.com/watch?v=" + ID, "NOT_A_VIDEO_URL");
    expectCode("", "INVALID_URL");
    expectCode("   ", "INVALID_URL");
  });

  it("diagnoses almost-right ids precisely", () => {
    try {
      validateVideoId("abc", "video id");
    } catch (err) {
      const te = err as TranscriptError;
      expect(te.code).toBe("INVALID_VIDEO_ID");
      expect(te.message).toMatch(/11 characters \(got 3\)/);
    }
    try {
      validateVideoId("dQw4w9WgXQ!", "video id");
    } catch (err) {
      expect((err as TranscriptError).message).toMatch(/A-Z, a-z, 0-9/);
    }
    try {
      validateVideoId("PLbcLMApnBcdFL5lG2u2YpFpgIPWdovbBU", "video id");
    } catch (err) {
      expect((err as TranscriptError).message).toMatch(/playlist/i);
    }
    expect(validateVideoId(ID)).toBe(ID);
  });

  it("rejects a bad v parameter rather than silently fetching something else", () => {
    expectCode("https://www.youtube.com/watch?v=short", "INVALID_VIDEO_ID");
  });
});

describe("resolveVideoId", () => {
  it("returns the parsed target for a video", () => {
    expect(resolveVideoId("https://youtu.be/" + ID).videoId).toBe(ID);
  });
  it("throws when no video id is present", () => {
    expect(() => resolveVideoId("https://www.youtube.com/feed/subscriptions")).toThrow(TranscriptError);
  });
});
