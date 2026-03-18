// ─────────────────────────────────────────────────────────────────────────────
// server.js — Instagram Reel Generator API (v6 — eliminate final re-encode)
// ─────────────────────────────────────────────────────────────────────────────
//
// CHANGES FROM v5 (fix SIGKILL on final render — still OOM at 720×1280):
//
// ROOT CAUSE: v5 encoded video TWICE.  Each clip was fully scaled and
// encoded to H.264 during extraction (step 7), then the final render
// (step 9) decoded ALL clips and re-encoded them again with libx264 just
// to add audio.  That second libx264 instance processing 8 seconds of
// 720×1280 video was what Railway killed.
//
// FIX: The final render now uses -c:v copy.  Since every clip is already
// 720×1280 H.264 yuv420p at 30fps with identical parameters, the concat
// produces a stream-copyable file.  The final step only muxes the existing
// video stream with a newly encoded audio track — no video decoder or
// encoder is instantiated, so peak memory drops from ~200 MB to ~20 MB.
//
// OTHER CHANGES:
//   - Clip count: 10 × 0.8s → 5 × 1.6s  (still 8s total, half the
//     FFmpeg invocations, half the temp files)
//   - Audio bitrate: 128k → 96k
//   - Max concurrent jobs: 3 → 1 (Railway free tier has ~512 MB)
//
// Drawtext is still disabled.  Pipeline: download → probe → extract 5
// clips → concat → mux audio (video copy) → serve.
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", activeJobs });
});

// ─── POST /render ────────────────────────────────────────────────────────────

app.post("/render", async (req, res) => {
  // ── 1. Parse & validate ──────────────────────────────────────────────────
  //
  // Defaults changed: 5 clips × 1.6s = 8s total.
  // The request body can still override these if needed.

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
    // Each clip is FULLY scaled and encoded here — 720×1280, H.264, yuv420p,
    // 30fps, veryfast, CRF 28.  This means the concat output will be
    // stream-copyable and the final step does NOT need to re-encode video.

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
    //
    // All clips have identical codec params so concat demuxer + stream copy
    // works reliably.  No re-encoding happens here.

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

    // ── 9. Final step: mux audio onto video (NO video re-encode) ───────────
    //
    // THIS IS THE KEY CHANGE.  v5 used:
    //   -vf "scale=...,pad=...,setsar=1"  ← forces decode + encode
    //   -c:v libx264 -preset veryfast     ← spawns full x264 encoder
    //
    // v6 uses:
    //   -c:v copy                         ← zero video processing
    //
    // The video is already 720×1280 H.264 yuv420p 30fps from clip extraction.
    // The concat just glued the packets together.  There is nothing left to
    // do to the video — we only need to lay the audio track alongside it.
    //
    // With -c:v copy, FFmpeg does not instantiate a video decoder or encoder.
    // It reads compressed H.264 packets from concatenated.mp4 and writes them
    // straight to the output.  Only the AAC audio encoder runs.
    //
    // Peak memory for this step: ~20 MB instead of ~200 MB.
    //
    // NOTE: -movflags +faststart is kept.  It does a second pass to move the
    // moov atom, but on an 8-second file at CRF 28 this is only a few MB of
    // I/O — not a memory concern.

    const actualFinalDuration = +(clipCount * clipDuration).toFixed(2);
    const outputFilename = `reel_${jobId}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);

    // ======================================================================
    // KEY LOG: FFmpeg started (final render)
    // ======================================================================
    console.log(`[${jobId}] FFmpeg started: final render (video copy, audio encode only)`);
    console.log(`[${jobId}]   duration: ${actualFinalDuration}s`);
    console.log(`[${jobId}]   output: ${outputPath}`);

    const finalResult = await runFFmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-i", concatenatedPath,           // video source (already encoded)
      "-stream_loop", "-1",
      "-i", audioPath,                   // audio source (loop if short)
      "-t", String(actualFinalDuration), // trim to 8 seconds
      "-map", "0:v:0",                  // video from concatenated file
      "-map", "1:a:0",                  // audio from audio file
      "-c:v", "copy",                   // NO video re-encode — pass through
      "-c:a", "aac",                    // encode audio only
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

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`Reel Generator API (v6) listening on ${HOST}:${PORT}`);
  console.log(`  BASE_URL: ${BASE_URL}`);
  console.log(`  Defaults: 5 clips × 1.6s, 720×1280, final render = video copy`);
  console.log(`  POST ${BASE_URL}/render`);
  console.log(`  GET  ${BASE_URL}/health`);
});