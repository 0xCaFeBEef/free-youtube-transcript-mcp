#!/usr/bin/env node
/**
 * CLI entrypoint.
 *
 * Default behaviour is a stdio MCP server. A few human-facing flags exist so the
 * exact same code path can be smoke-tested in a terminal before wiring the
 * server into an MCP client.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { config } from "./config.js";
import { getTranscript, getVideoInfo, listLanguages } from "./service.js";
import { toTranscriptError } from "./errors.js";

const HELP = [
  "youtube-transcript-mcp " + SERVER_VERSION,
  "",
  "An MCP server that returns the transcript of a YouTube video from any YouTube URL.",
  "",
  "Usage",
  "  youtube-transcript-mcp                  start the MCP server on stdio (default)",
  "  youtube-transcript-mcp --help           show this help",
  "  youtube-transcript-mcp --version        print the version",
  "  youtube-transcript-mcp --probe <url>    fetch one transcript and print it",
  "  youtube-transcript-mcp --info <url>     print caption availability for one video",
  "  youtube-transcript-mcp --list-languages <url>",
  "                                          list caption tracks",
  "",
  "Options with --probe",
  "  --lang <code>       preferred language, repeatable (default: en)",
  "  --format <name>     text | srt | vtt | markdown | segments (default: text)",
  "  --timestamps        prefix lines with [mm:ss]",
  "  --translate <code>  machine-translate the transcript",
  "  --no-auto           refuse auto-generated captions",
  "  --json              print the full structured result",
  "",
  "Environment",
  "  YTA_HL / YTA_GL       interface language / region sent to YouTube (default en / US)",
  "  YTA_COOKIES           raw Cookie header (age-restricted or your own private videos)",
  "  YTA_COOKIES_FILE      Netscape cookie file, also passed to yt-dlp",
  "  YTA_TIMEOUT_MS        per-request timeout (default 20000)",
  "  YTA_RETRIES           transport retries (default 2)",
  "  YTA_MAX_CHARS         transcript cap per call (default 200000)",
  "  YTA_CACHE_TTL_MS      transcript cache lifetime (default 300000)",
  "  YTA_YTDLP             auto | never | always (default auto)",
  "  YTA_YTDLP_PATH        path to the yt-dlp binary (default: yt-dlp on PATH)",
  "  YTA_PROVIDERS         provider order override, e.g. innertube,yt-dlp",
  "",
  "Exit codes: 0 ok, 1 hard failure, 75 retryable (rate limit or transient).",
  "",
].join("\n");

type Command = "serve" | "probe" | "info" | "languages" | "help" | "version";
type Format = "text" | "srt" | "vtt" | "markdown" | "segments";

interface CliArgs {
  command: Command;
  url?: string;
  languages: string[];
  format: Format;
  timestamps: boolean;
  translateTo?: string;
  includeAutoCaptions: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "serve",
    languages: [],
    format: "text",
    timestamps: false,
    includeAutoCaptions: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--help":
      case "-h":
        args.command = "help";
        break;
      case "--version":
      case "-v":
        args.command = "version";
        break;
      case "--probe":
      case "-p":
        args.command = "probe";
        args.url = next();
        break;
      case "--info":
      case "-i":
        args.command = "info";
        args.url = next();
        break;
      case "--list-languages":
      case "--list-langs":
      case "--langs":
      case "--languages":
      case "-l":
        args.command = "languages";
        args.url = next();
        break;
      case "--lang": {
        const v = next();
        if (v) args.languages.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--format":
        args.format = (next() as Format) ?? "text";
        break;
      case "--timestamps":
        args.timestamps = true;
        break;
      case "--translate":
        args.translateTo = next();
        break;
      case "--no-auto":
        args.includeAutoCaptions = false;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        if (!a.startsWith("-") && !args.url) args.url = a;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === "version") {
    process.stdout.write(SERVER_VERSION + "\n");
    return;
  }

  if (args.command === "serve") {
    const server = createServer(config);
    await server.connect(new StdioServerTransport());
    process.stderr.write(SERVER_NAME + " " + SERVER_VERSION + " ready on stdio\n");
    return;
  }

  if (!args.url) {
    process.stderr.write("Missing URL. Try --help.\n");
    process.exitCode = 2;
    return;
  }

  try {
    if (args.command === "info") {
      process.stdout.write(JSON.stringify(await getVideoInfo(args.url, config), null, 2) + "\n");
      return;
    }
    if (args.command === "languages") {
      process.stdout.write(JSON.stringify(await listLanguages(args.url, config), null, 2) + "\n");
      return;
    }
    const result = await getTranscript(
      {
        url: args.url,
        languages: args.languages.length ? args.languages : undefined,
        output: args.format,
        timestamps: args.timestamps,
        translateTo: args.translateTo,
        includeAutoCaptions: args.includeAutoCaptions,
      },
      config,
    );
    process.stdout.write((args.json ? JSON.stringify(result, null, 2) : result.text ?? JSON.stringify(result.segments ?? [])) + "\n");
  } catch (err) {
    const te = toTranscriptError(err);
    process.stderr.write(JSON.stringify(te.toJSON(), null, 2) + "\n");
    process.exitCode = te.retryable ? 75 : 1;
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify(toTranscriptError(err).toJSON(), null, 2) + "\n");
  process.exitCode = 1;
});
