// ─────────────────────────────────────────────────────────────────────────────
// server.js — Instagram Reel Generator API (v8 — public URL fix)
// ─────────────────────────────────────────────────────────────────────────────
//
// CHANGES FROM v6:
//
// 1. DRAWTEXT RE-ENABLED on the final render step.
//
// 2. Final render now uses -c:v libx264 instead of -c:v copy, because
//    drawtext modifies pixel data which requires decode → filter → encode.
//    This is unavoidable — there is no way to burn text onto compressed
//    video without re-encoding.
//
// 3. To keep memory low despite the re-encode, the final render adds:
//      -threads 1          caps libx264 to 1 worker thread (~60 MB less)
//      -preset veryfast    1 reference frame, fast ME
//      -crf 28             low bitrate output
//    The input is only 8 seconds of 720×1280 — much smaller than the
//    original source video — so peak memory stays well under 512 MB.
//
// 4. Font detection restored (pickFont helper) with safe fallback.
//
// 5. Phrase escaping uses FFmpeg-only rules (colons, backslashes, single
//    quotes).  No shell escapes needed because spawn() bypasses /bin/sh.
//
// Pipeline: download → probe → extract 5 clips (scale+encode) → concat
// (stream copy) → drawtext + audio replace (re-encode) → serve.
//
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { spawn, execFileSync } = require("child_process");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// PUBLIC_BASE_URL is the preferred way to set the public URL explicitly.
// If not set, the URL is derived from request headers at runtime.
// The old BASE_URL env var is still accepted as a fallback for compatibility.
const STATIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || null;

const OUTPUTS_DIR = path.join(__dirname, "outputs");
const TEMP_ROOT = path.join(__dirname, "tmp");
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 1;
let activeJobs = 0;

fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
fs.mkdirSync(TEMP_ROOT, { recursive: true });

// ─── Verify ffmpeg / ffprobe ─────────────────────────────────────────────────

function checkDependencies() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    console.log("[startup] ffmpeg and ffprobe found");
  } catch {
    console.error(
      "[startup] ffmpeg or ffprobe not found.\n" +
        "  Ubuntu/Debian: sudo apt-get install ffmpeg\n" +
        "  macOS:         brew install ffmpeg"
    );
    process.exit(1);
  }
}

checkDependencies();

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/outputs", express.static(OUTPUTS_DIR));

// Trust Railway's (and Render's) reverse proxy so req.protocol and
// req.get("host") reflect the real public-facing values, not the
// container's internal 0.0.0.0:3000.
app.set("trust proxy", true);

// ─── Resolve the public base URL ─────────────────────────────────────────
//
// Priority:
//   1. PUBLIC_BASE_URL or BASE_URL env var (explicit, always wins)
//   2. x-forwarded-proto + x-forwarded-host headers (set by Railway/Render)
//   3. req.protocol + req.get("host") (Express built-in, trust proxy aware)
//
// This is called per-request so it works even when the public URL isn't
// known at startup (e.g. Railway auto-assigned domains).

function getPublicBaseUrl(req) {
  // 1. Explicit env var — highest priority
  if (STATIC_BASE_URL) {
    // Strip trailing slash if someone set "https://foo.com/"
    return STATIC_BASE_URL.replace(/\/+$/, "");
  }

  // 2. Forwarded headers from the reverse proxy
  const fwdProto = req.get("x-forwarded-proto");
  const fwdHost = req.get("x-forwarded-host");
  if (fwdProto && fwdHost) {
    return `${fwdProto}://${fwdHost}`;
  }

  // 3. Express built-in (trust proxy makes these reflect the real values)
  return `${req.protocol}://${req.get("host")}`;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", activeJobs });
});

// ─── POST /render ────────────────────────────────────────────────────────────

app.post("/render", async (req, res) => {
  // ── 1. Parse & validate ──────────────────────────────────────────────────

  const {
    sourceVideoUrl,
    audioUrl,
    phrase = "",
    clipCount = 5,
    clipDuration = 1.6,
    finalDuration = 8,
    width = 720,
    height = 1280,
  } = req.body;

  if (!sourceVideoUrl || !audioUrl) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: sourceVideoUrl and audioUrl.",
      exitCode: null,
      signal: null,
    });
  }

  if (clipCount < 1 || clipCount > 100) {
    return res.status(400).json({
      success: false,
      error: "clipCount must be between 1 and 100.",
      exitCode: null,
      signal: null,
    });
  }

  // ── 2. Concurrency guard ─────────────────────────────────────────────────

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({
      success: false,
      error: `Server busy — ${activeJobs} jobs running.`,
      exitCode: null,
      signal: null,
    });
  }

  activeJobs++;

  const jobId = uuidv4();
  const jobDir = path.join(TEMP_ROOT, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // ========================================================================
  // KEY LOG: Render request started
  // ========================================================================
  console.log(`[${jobId}] Render request started`);
  console.log(`[${jobId}]   sourceVideoUrl: ${sourceVideoUrl}`);
  console.log(`[${jobId}]   audioUrl: ${audioUrl}`);
  console.log(`[${jobId}]   phrase: "${phrase}"`);
  console.log(`[${jobId}]   clips: ${clipCount} × ${clipDuration}s = ${clipCount * clipDuration}s`);
  console.log(`[${jobId}]   resolution: ${width}×${height}`);

  try {
    // ── 3. Download source video ───────────────────────────────────────────

    const sourceVideoPath = path.join(jobDir, "source_video.mp4");
    await downloadFile(sourceVideoUrl, sourceVideoPath);
    const videoBytes = fs.statSync(sourceVideoPath).size;

    // ======================================================================
    // KEY LOG: Source video downloaded
    // ======================================================================
    console.log(`[${jobId}] Source video downloaded (${videoBytes} bytes)`);

    // ── 4. Download audio ──────────────────────────────────────────────────

    const audioPath = path.join(jobDir, "audio_input.mp3");
    await downloadFile(audioUrl, audioPath);
    const audioBytes = fs.statSync(audioPath).size;

    // ======================================================================
    // KEY LOG: Audio downloaded
    // ======================================================================
    console.log(`[${jobId}] Audio downloaded (${audioBytes} bytes)`);

    // ── 5. Probe duration ──────────────────────────────────────────────────

    const videoDuration = await getVideoDuration(sourceVideoPath);
    console.log(`[${jobId}] Video duration: ${videoDuration}s`);

    if (videoDuration < clipDuration) {
      throw new Error(
        `Source video too short (${videoDuration}s). Need >= ${clipDuration}s.`
      );
    }

    // ── 6. Random start times ──────────────────────────────────────────────

    const maxStart = videoDuration - clipDuration;
    const startTimes = [];
    for (let i = 0; i < clipCount; i++) {
      startTimes.push(+(Math.random() * maxStart).toFixed(3));
    }

    // ── 7. Extract clips ───────────────────────────────────────────────────
    //
    // Each clip is fully scaled and encoded to 720×1280 H.264 yuv420p 30fps.
    // Concat can then stream-copy these identical-parameter clips.

    const scaleFilter =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,` +
      `setsar=1`;

    const clipPaths = [];

    for (let i = 0; i < clipCount; i++) {
      const clipPath = path.join(
        jobDir,
        `clip_${String(i).padStart(3, "0")}.mp4`
      );
      clipPaths.push(clipPath);

      // ==================================================================
      // KEY LOG: FFmpeg started (clip extraction)
      // ==================================================================
      console.log(
        `[${jobId}] FFmpeg started: clip ${i + 1}/${clipCount} at ${startTimes[i]}s`
      );

      const result = await runFFmpeg([
        "-hide_banner",
        "-loglevel", "error",
        "-ss", String(startTimes[i]),
        "-i", sourceVideoPath,
        "-t", String(clipDuration),
        "-vf", scaleFilter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-an",
        "-r", "30",
        "-pix_fmt", "yuv420p",
        "-y",
        clipPath,
      ]);

      // ==================================================================
      // KEY LOG: FFmpeg exited (clip)
      // ==================================================================
      console.log(
        `[${jobId}] FFmpeg exited with code: ${result.code} signal: ${result.signal}`
      );

      const clipExists = fs.existsSync(clipPath);
      console.log(`[${jobId}] Output exists: ${clipExists}`);

      if (clipExists) {
        const clipSize = fs.statSync(clipPath).size;
        console.log(`[${jobId}] Output size: ${clipSize}`);
      }

      if (!clipExists || result.code !== 0) {
        return res.status(500).json({
          success: false,
          error: result.stderr || `Clip ${i + 1} extraction failed`,
          exitCode: result.code,
          signal: result.signal,
        });
      }
    }

    // ── 8. Concatenate ─────────────────────────────────────────────────────

    const concatListPath = path.join(jobDir, "concat_list.txt");
    fs.writeFileSync(
      concatListPath,
      clipPaths.map((p) => `file '${p}'`).join("\n")
    );

    const concatenatedPath = path.join(jobDir, "concatenated.mp4");

    console.log(`[${jobId}] FFmpeg started: concatenation`);

    const concatResult = await runFFmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-y",
      concatenatedPath,
    ]);

    console.log(
      `[${jobId}] FFmpeg exited with code: ${concatResult.code} signal: ${concatResult.signal}`
    );

    const concatExists = fs.existsSync(concatenatedPath);
    console.log(`[${jobId}] Output exists: ${concatExists}`);

    if (concatExists) {
      const concatSize = fs.statSync(concatenatedPath).size;
      console.log(`[${jobId}] Output size: ${concatSize}`);
    }

    if (!concatExists || concatResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: concatResult.stderr || "Concatenation failed",
        exitCode: concatResult.code,
        signal: concatResult.signal,
      });
    }

    // ── 9. Final render: drawtext + audio replace ──────────────────────────
    //
    // This step now re-encodes video because drawtext modifies pixel data.
    // The input is only 8 seconds of 720×1280 (the concatenated file),
    // NOT the original source video, so the encoder workload is small.
    //
    // Memory controls:
    //   -threads 1    → libx264 uses 1 encoding thread (fewer frame buffers)
    //   -preset veryfast → 1 reference frame
    //   -crf 28       → low bitrate output

    // Escape the phrase for FFmpeg's drawtext filter.
    // Only FFmpeg-level escapes are needed — no shell escapes because
    // spawn() passes args directly to ffmpeg without invoking /bin/sh.
    //
    // FFmpeg drawtext special characters:
    //   \  → \\       (backslash is escape char in drawtext)
    //   :  → \:       (colon separates key=value pairs in drawtext)
    //   '  → '\''     (end single-quoted string, escaped quote, reopen)
    const escapedPhrase = phrase
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "'\\''");

    // Find a bold font file, or fall back to ffmpeg's built-in default
    const fontFile = pickFont();
    const fontClause = fontFile ? `fontfile='${fontFile}':` : "";

    // Build the -vf filter chain as a single string.
    // spawn() passes this as one argv element — no shell parsing.
    const drawtextFilter =
      `drawtext=` +
      `${fontClause}` +
      `text='${escapedPhrase}':` +
      `fontsize=80:` +
      `fontcolor=white:` +
      `borderw=4:` +
      `bordercolor=black:` +
      `x=(w-text_w)/2:` +
      `y=(h-text_h)/2-h*0.05`;

    // No scale/pad needed — video is already 720×1280 from clip extraction.
    // drawtext is the only video filter.
    const videoFilter = drawtextFilter;

    const actualFinalDuration = +(clipCount * clipDuration).toFixed(2);
    const outputFilename = `reel_${jobId}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);

    // ======================================================================
    // KEY LOG: FFmpeg started (final render)
    // ======================================================================
    console.log(`[${jobId}] FFmpeg started: final render (drawtext + audio)`);
    console.log(`[${jobId}]   phrase: "${phrase}"`);
    console.log(`[${jobId}]   font: ${fontFile || "ffmpeg default"}`);
    console.log(`[${jobId}]   duration: ${actualFinalDuration}s`);
    console.log(`[${jobId}]   output: ${outputPath}`);

    const finalResult = await runFFmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-i", concatenatedPath,           // video source (720×1280 H.264)
      "-stream_loop", "-1",
      "-i", audioPath,                   // audio source (loop if short)
      "-t", String(actualFinalDuration), // trim to 8 seconds
      "-vf", videoFilter,               // drawtext overlay
      "-map", "0:v:0",                  // video from concat
      "-map", "1:a:0",                  // audio from audio file
      "-c:v", "libx264",               // must re-encode for drawtext
      "-preset", "veryfast",
      "-crf", "28",
      "-threads", "1",                  // cap encoder memory
      "-r", "30",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);

    // ======================================================================
    // KEY LOG: FFmpeg finished/failed + output check
    // ======================================================================
    console.log(
      `[${jobId}] FFmpeg exited with code: ${finalResult.code} signal: ${finalResult.signal}`
    );

    const outputExists = fs.existsSync(outputPath);
    console.log(`[${jobId}] Output exists: ${outputExists}`);

    if (outputExists) {
      const outputSize = fs.statSync(outputPath).size;
      console.log(`[${jobId}] Output size: ${outputSize}`);
    }

    // ── 10. Return result ──────────────────────────────────────────────────

    if (!outputExists) {
      console.log(`[${jobId}] Returning failure: output file missing after ffmpeg`);

      return res.status(500).json({
        success: false,
        error: "Output file missing after ffmpeg",
        exitCode: finalResult.code,
        signal: finalResult.signal,
      });
    }

    if (finalResult.code !== 0) {
      console.log(
        `[${jobId}] Returning failure: ffmpeg exited ${finalResult.code}`
      );
      console.log(`[${jobId}] stderr: ${finalResult.stderr}`);

      return res.status(500).json({
        success: false,
        error: finalResult.stderr || `FFmpeg exited with code ${finalResult.code}`,
        exitCode: finalResult.code,
        signal: finalResult.signal,
      });
    }

    const publicBase = getPublicBaseUrl(req);
    const finalMp4Url = `${publicBase}/outputs/${outputFilename}`;

    // ======================================================================
    // KEY LOG: Returning success
    // ======================================================================
    console.log(`[${jobId}] Returning success: ${finalMp4Url}`);

    return res.json({
      success: true,
      jobId,
      finalMp4Url,
    });
  } catch (err) {
    // ======================================================================
    // KEY LOG: Returning failure — exception
    // ======================================================================
    console.log(`[${jobId}] Returning failure: ${err.message}`);
    if (err.stderr) {
      console.log(`[${jobId}] stderr: ${err.stderr}`);
    }

    return res.status(500).json({
      success: false,
      error: err.message,
      exitCode: null,
      signal: null,
    });
  } finally {
    activeJobs--;
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch (_) {
      // cleanup is best-effort
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: download a remote file
// ─────────────────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120_000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    maxRedirects: 5,
  });

  const writer = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    let bytes = 0;

    response.data.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) {
        writer.destroy();
        reject(new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} bytes.`));
      }
    });

    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", (err) =>
      reject(new Error(`File write error: ${err.message}`))
    );
    response.data.on("error", (err) =>
      reject(new Error(`Download stream error: ${err.message}`))
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: get video duration via ffprobe
// ─────────────────────────────────────────────────────────────────────────────

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-hide_banner",
      "-loglevel", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffprobe timed out after 30s"));
    }, 30_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr}`));
        return;
      }
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration) || duration <= 0) {
        reject(new Error(`ffprobe invalid duration: "${stdout.trim()}"`));
      } else {
        resolve(duration);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`ffprobe spawn error: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: run FFmpeg via spawn — quiet mode
// ─────────────────────────────────────────────────────────────────────────────
//
// spawn() passes args directly to ffmpeg via execvp(). No shell involved.
// Returns { code, signal, stderr } — always resolves, never rejects.

function runFFmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stdout.on("data", () => {});
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 600_000);

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (stderr.trim()) {
        console.log(`[ffmpeg:stderr] ${stderr.trim()}`);
      }
      resolve({ code, signal, stderr: stderr.trim() });
    });

    proc.on("error", (spawnErr) => {
      clearTimeout(timeout);
      resolve({
        code: null,
        signal: null,
        stderr: `spawn error: ${spawnErr.message}`,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: pick a bold font file
// ─────────────────────────────────────────────────────────────────────────────
//
// Tries common system font paths.  Returns the first one found, or null
// to let ffmpeg fall back to its built-in default.

function pickFont() {
  const candidates = [
    // Ubuntu / Debian (Railway's Docker images)
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-Bold.ttf",
    // Alpine
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    // RHEL / CentOS / Fedora
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
    // macOS
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Bold.ttf",
  ];

  for (const fp of candidates) {
    if (fs.existsSync(fp)) {
      return fp;
    }
  }

  return null;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`Reel Generator API (v8) listening on ${HOST}:${PORT}`);
  console.log(`  PUBLIC_BASE_URL: ${STATIC_BASE_URL || "(not set — will derive from request headers)"}`);
  console.log(`  Defaults: 5 clips × 1.6s, 720×1280, drawtext ENABLED`);
  console.log(`  POST /render`);
  console.log(`  GET  /health`);
});