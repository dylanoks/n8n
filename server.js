// ─────────────────────────────────────────────────────────────────────────────
// server.js — Instagram Reel Generator API (v4 — quiet FFmpeg, clean logs)
// ─────────────────────────────────────────────────────────────────────────────
//
// CHANGES FROM v3:
//
// 1. FFmpeg runs with -hide_banner -loglevel error so it only emits output
//    when something actually goes wrong.  No more codec tables, encoding
//    speed lines, or frame counters flooding Railway logs.
//
// 2. runFFmpeg no longer streams stderr line-by-line to console during
//    execution.  It buffers stderr silently, then:
//      • On success → logs one line: "FFmpeg exited with code: 0 signal: null"
//      • On failure → logs that same line PLUS the full stderr buffer.
//    Because loglevel is "error", the buffer will only contain actual errors.
//
// 3. After every FFmpeg call the route handler logs exactly:
//      FFmpeg exited with code: <code> signal: <signal>
//      Output exists: true/false
//      Output size: <bytes>
//    So you can ctrl-F these three lines in Railway to see the outcome.
//
// 4. Drawtext is still disabled.  Pipeline: download → probe → extract →
//    concat → scale + audio replace → serve.
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
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OUTPUTS_DIR = path.join(__dirname, "outputs");
const TEMP_ROOT = path.join(__dirname, "tmp");
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 3;
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
    clipCount = 10,
    clipDuration = 0.8,
    finalDuration = 8,
    width = 1080,
    height = 1920,
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
        "-preset", "fast",
        "-crf", "23",
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

    // ── 9. Final render: scale + audio replace (drawtext DISABLED) ─────────

    const finalVideoFilter = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      `setsar=1`,
    ].join(",");

    const actualFinalDuration = +(clipCount * clipDuration).toFixed(2);
    const outputFilename = `reel_${jobId}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);

    // ======================================================================
    // KEY LOG: FFmpeg started (final render)
    // ======================================================================
    console.log(`[${jobId}] FFmpeg started: final render`);
    console.log(`[${jobId}]   duration: ${actualFinalDuration}s`);
    console.log(`[${jobId}]   output: ${outputPath}`);

    const finalResult = await runFFmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-i", concatenatedPath,
      "-stream_loop", "-1",
      "-i", audioPath,
      "-t", String(actualFinalDuration),
      "-vf", finalVideoFilter,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-r", "30",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);

    // ======================================================================
    // KEY LOG: FFmpeg finished/failed + output check
    // These three lines are the ones to search for in Railway logs.
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
      // ==================================================================
      // KEY LOG: Returning failure — file missing
      // ==================================================================
      console.log(`[${jobId}] Returning failure: output file missing after ffmpeg`);

      return res.status(500).json({
        success: false,
        error: "Output file missing after ffmpeg",
        exitCode: finalResult.code,
        signal: finalResult.signal,
      });
    }

    if (finalResult.code !== 0) {
      // ==================================================================
      // KEY LOG: Returning failure — non-zero exit
      // ==================================================================
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

    const finalMp4Url = `${BASE_URL}/outputs/${outputFilename}`;

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
// Uses spawn with an args array — no shell involved.

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
// spawn() passes the args array directly to the ffmpeg binary via execvp().
// No shell is involved — parentheses, quotes, and special characters in
// filter expressions are passed as-is.
//
// The caller is responsible for including -hide_banner and -loglevel error
// in the args array.  This function buffers stderr silently and returns a
// result object instead of throwing, so the caller can inspect the exit
// code, signal, and stderr before deciding how to respond.
//
// Return value:
//   { code: number|null, signal: string|null, stderr: string }

function runFFmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    // stdout is unused by ffmpeg when writing to a file, but drain it
    proc.stdout.on("data", () => {});

    // Buffer stderr — with -loglevel error this will only contain actual
    // error messages, not the hundreds of progress/info lines from before.
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 600_000);

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);

      // If stderr has content, log it now — these are real errors.
      if (stderr.trim()) {
        console.log(`[ffmpeg:stderr] ${stderr.trim()}`);
      }

      // Always resolve (never reject) so the caller can inspect the
      // result and build the appropriate API response.
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

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`Reel Generator API (v4) listening on ${HOST}:${PORT}`);
  console.log(`  BASE_URL: ${BASE_URL}`);
  console.log(`  POST ${BASE_URL}/render`);
  console.log(`  GET  ${BASE_URL}/health`);
});