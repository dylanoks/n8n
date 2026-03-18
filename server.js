// ─────────────────────────────────────────────────────────────────────────────
// server.js — Instagram Reel Generator API (v3 — debug build)
// ─────────────────────────────────────────────────────────────────────────────
//
// CHANGES FROM v2:
//
// 1. SIMPLIFIED PIPELINE — drawtext overlay is disabled. The render now does
//    only: download → probe → extract clips → concat → scale + audio replace.
//    This isolates whether the failure is in the core FFmpeg pipeline or in
//    the text overlay filter. Re-enable drawtext once this version works.
//
// 2. FULL STDERR IN LOGS — FFmpeg's stderr is streamed line-by-line to
//    console.error() in real time so it appears in Railway's log viewer
//    as it happens, not buffered until the process exits.
//
// 3. FULL STDERR IN API RESPONSE — on failure the entire stderr string is
//    returned in the JSON body so n8n can display the complete error.
//
// 4. STRUCTURED ERROR RESPONSE — failures return:
//    { success: false, error: "...", exitCode: N, signal: "SIGKILL"|null }
//
// 5. STEP LOGGING — every phase logs start/finish with timestamps so you
//    can see exactly where the pipeline stalls or dies in Railway logs.
//
// 6. FFPROBE VIA SPAWN — getVideoDuration now uses spawn instead of
//    execFileSync, with full stderr capture on failure.
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

// ─── Verify ffmpeg / ffprobe are available ───────────────────────────────────

function checkDependencies() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    console.log("[startup] ✓ ffmpeg and ffprobe found");
  } catch {
    console.error(
      "[startup] ✗ ffmpeg or ffprobe not found.\n" +
        "  Ubuntu/Debian: sudo apt-get install ffmpeg\n" +
        "  macOS:         brew install ffmpeg"
    );
    process.exit(1);
  }
}

checkDependencies();

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/outputs", express.static(OUTPUTS_DIR));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", activeJobs });
});

// ─── POST /render ────────────────────────────────────────────────────────────

app.post("/render", async (req, res) => {
  const startTime = Date.now();

  // ── 1. Validate ──────────────────────────────────────────────────────────

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

  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`[render] REQUEST RECEIVED at ${new Date().toISOString()}`);
  console.log(`[render]   sourceVideoUrl: ${sourceVideoUrl}`);
  console.log(`[render]   audioUrl:       ${audioUrl}`);
  console.log(`[render]   phrase:         "${phrase}"`);
  console.log(`[render]   clipCount:      ${clipCount}`);
  console.log(`[render]   clipDuration:   ${clipDuration}s`);
  console.log(`[render]   resolution:     ${width}x${height}`);
  console.log("══════════════════════════════════════════════════════════");

  if (!sourceVideoUrl || !audioUrl) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: sourceVideoUrl and audioUrl are required.",
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
    console.warn(`[render] REJECTED — ${activeJobs} jobs already running`);
    return res.status(503).json({
      success: false,
      error: `Server busy — ${activeJobs} jobs running. Try again shortly.`,
      exitCode: null,
      signal: null,
    });
  }

  activeJobs++;

  // ── 3. Job directory ─────────────────────────────────────────────────────

  const jobId = uuidv4();
  const jobDir = path.join(TEMP_ROOT, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`[${jobId}] Job directory created: ${jobDir}`);

  try {
    // ── 4. Download source video ───────────────────────────────────────────

    const sourceVideoPath = path.join(jobDir, "source_video.mp4");
    console.log(`[${jobId}] STEP 1/6 — Downloading source video …`);
    console.log(`[${jobId}]   URL: ${sourceVideoUrl}`);
    const dlVideoStart = Date.now();
    await downloadFile(sourceVideoUrl, sourceVideoPath);
    const videoSize = fs.statSync(sourceVideoPath).size;
    console.log(
      `[${jobId}]   ✓ Downloaded ${(videoSize / 1024 / 1024).toFixed(1)} MB ` +
        `in ${((Date.now() - dlVideoStart) / 1000).toFixed(1)}s`
    );

    // ── 5. Download audio ──────────────────────────────────────────────────

    const audioPath = path.join(jobDir, "audio_input.mp3");
    console.log(`[${jobId}] STEP 2/6 — Downloading audio …`);
    console.log(`[${jobId}]   URL: ${audioUrl}`);
    const dlAudioStart = Date.now();
    await downloadFile(audioUrl, audioPath);
    const audioSize = fs.statSync(audioPath).size;
    console.log(
      `[${jobId}]   ✓ Downloaded ${(audioSize / 1024 / 1024).toFixed(1)} MB ` +
        `in ${((Date.now() - dlAudioStart) / 1000).toFixed(1)}s`
    );

    // ── 6. Probe video duration ────────────────────────────────────────────

    console.log(`[${jobId}] STEP 3/6 — Probing video duration with ffprobe …`);
    const videoDuration = await getVideoDuration(sourceVideoPath, jobId);
    console.log(`[${jobId}]   ✓ Source duration: ${videoDuration}s`);

    if (videoDuration < clipDuration) {
      throw new Error(
        `Source video too short (${videoDuration}s). Need ≥ ${clipDuration}s.`
      );
    }

    // ── 7. Random start times ──────────────────────────────────────────────

    const maxStart = videoDuration - clipDuration;
    const startTimes = [];
    for (let i = 0; i < clipCount; i++) {
      startTimes.push(+(Math.random() * maxStart).toFixed(3));
    }
    console.log(`[${jobId}]   Start times: [${startTimes.join(", ")}]`);

    // ── 8. Extract clips ───────────────────────────────────────────────────

    // Video filter: scale to target with letterboxing.
    // Parentheses in (ow-iw)/2 are safe because spawn() does not use a shell.
    const scaleFilter =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,` +
      `setsar=1`;

    console.log(`[${jobId}] STEP 4/6 — Extracting ${clipCount} clips …`);
    console.log(`[${jobId}]   Filter: ${scaleFilter}`);

    const clipPaths = [];
    for (let i = 0; i < clipCount; i++) {
      const clipPath = path.join(
        jobDir,
        `clip_${String(i).padStart(3, "0")}.mp4`
      );
      clipPaths.push(clipPath);

      const clipArgs = [
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
      ];

      console.log(`[${jobId}]   Clip ${i + 1}/${clipCount} — seek ${startTimes[i]}s`);
      await runFFmpeg(clipArgs, jobId, `clip-${i + 1}`);

      // Verify the clip was actually written
      if (!fs.existsSync(clipPath)) {
        throw new Error(`Clip file was not created: ${clipPath}`);
      }
      const clipSize = fs.statSync(clipPath).size;
      console.log(`[${jobId}]     → ${(clipSize / 1024).toFixed(0)} KB`);
    }
    console.log(`[${jobId}]   ✓ All ${clipCount} clips extracted`);

    // ── 9. Concat list ─────────────────────────────────────────────────────

    const concatListPath = path.join(jobDir, "concat_list.txt");
    const concatListContent = clipPaths.map((p) => `file '${p}'`).join("\n");
    fs.writeFileSync(concatListPath, concatListContent);
    console.log(`[${jobId}] STEP 5/6 — Concatenating clips …`);
    console.log(`[${jobId}]   Concat list:\n${concatListContent}`);

    const concatenatedPath = path.join(jobDir, "concatenated.mp4");
    await runFFmpeg(
      [
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c", "copy",
        "-y",
        concatenatedPath,
      ],
      jobId,
      "concat"
    );

    if (!fs.existsSync(concatenatedPath)) {
      throw new Error(`Concatenated file was not created: ${concatenatedPath}`);
    }
    const concatSize = fs.statSync(concatenatedPath).size;
    console.log(
      `[${jobId}]   ✓ Concatenated: ${(concatSize / 1024 / 1024).toFixed(1)} MB`
    );

    // ── 10. Final render: scale + audio replace (NO drawtext) ──────────────

    // DRAWTEXT IS DISABLED for debugging.
    // The video filter only does scale + pad + setsar.
    // Once this pipeline succeeds end-to-end, re-enable drawtext.
    const finalVideoFilter = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      `setsar=1`,
    ].join(",");

    const actualFinalDuration = +(clipCount * clipDuration).toFixed(2);
    const outputFilename = `reel_${jobId}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);

    console.log(`[${jobId}] STEP 6/6 — Final render (drawtext DISABLED) …`);
    console.log(`[${jobId}]   Video filter: ${finalVideoFilter}`);
    console.log(`[${jobId}]   Duration:     ${actualFinalDuration}s`);
    console.log(`[${jobId}]   Output:       ${outputPath}`);

    const finalArgs = [
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
    ];

    await runFFmpeg(finalArgs, jobId, "final-render");

    // Verify output
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Output file was not created: ${outputPath}`);
    }
    const outputSize = fs.statSync(outputPath).size;
    if (outputSize < 1024) {
      throw new Error(
        `Output file suspiciously small (${outputSize} bytes). Likely corrupt.`
      );
    }

    // ── 11. Done ───────────────────────────────────────────────────────────

    const finalMp4Url = `${BASE_URL}/outputs/${outputFilename}`;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`[${jobId}] ══════════════════════════════════════════════`);
    console.log(`[${jobId}] ✅ SUCCESS in ${elapsed}s`);
    console.log(`[${jobId}]   Size: ${(outputSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[${jobId}]   URL:  ${finalMp4Url}`);
    console.log(`[${jobId}] ══════════════════════════════════════════════\n`);

    return res.json({
      success: true,
      jobId,
      finalMp4Url,
      meta: {
        clips: clipCount,
        clipDuration,
        totalDuration: actualFinalDuration,
        resolution: `${width}x${height}`,
        phrase,
        drawtextEnabled: false,
        elapsedSeconds: parseFloat(elapsed),
        outputSizeMB: +(outputSize / 1024 / 1024).toFixed(1),
      },
    });
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.error(`[${jobId}] ══════════════════════════════════════════════`);
    console.error(`[${jobId}] ✗ FAILED after ${elapsed}s`);
    console.error(`[${jobId}]   Error: ${err.message}`);
    if (err.ffmpegStderr) {
      console.error(`[${jobId}]   FFmpeg stderr (${err.ffmpegStderr.length} chars):`);
      console.error(err.ffmpegStderr);
    }
    console.error(`[${jobId}] ══════════════════════════════════════════════\n`);

    return res.status(500).json({
      success: false,
      jobId,
      error: err.ffmpegStderr || err.message,
      exitCode: err.ffmpegExitCode ?? null,
      signal: err.ffmpegSignal ?? null,
    });
  } finally {
    activeJobs--;
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
      console.log(`[${jobId}] 🧹 Temp directory cleaned up`);
    } catch (cleanupErr) {
      console.warn(
        `[${jobId}] ⚠ Cleanup failed: ${cleanupErr.message}`
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: download a remote file to disk
// ─────────────────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120_000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    // Follow redirects (some CDNs / signed URLs redirect)
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
// Helper: get video duration via ffprobe (spawn, not execFileSync)
// ─────────────────────────────────────────────────────────────────────────────
// Uses spawn so we can capture full stderr if ffprobe fails.

function getVideoDuration(filePath, jobId) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];

    console.log(`[${jobId}]   ffprobe args: ${JSON.stringify(args)}`);

    const proc = spawn("ffprobe", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Stream to console in real time
      text.split("\n").filter(Boolean).forEach((line) => {
        console.error(`[${jobId}]   [ffprobe:err] ${line}`);
      });
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffprobe timed out after 30s."));
    }, 30_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        const err = new Error(
          `ffprobe exited with code ${code}.\nstderr: ${stderr}`
        );
        reject(err);
        return;
      }

      const duration = parseFloat(stdout.trim());
      if (isNaN(duration) || duration <= 0) {
        reject(
          new Error(
            `ffprobe returned invalid duration: "${stdout.trim()}"\nstderr: ${stderr}`
          )
        );
      } else {
        resolve(duration);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start ffprobe: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: run FFmpeg via spawn with full diagnostic logging
// ─────────────────────────────────────────────────────────────────────────────
//
// Key differences from v2:
//
// 1. Both stdout AND stderr are streamed line-by-line to console in real time
//    so they appear in Railway's log viewer as they happen.
//
// 2. The FULL stderr buffer (not just the last 8 lines) is attached to the
//    error object so the API can return it to n8n.
//
// 3. The error object carries .ffmpegExitCode and .ffmpegSignal so the API
//    response can include structured diagnostics.
//
// 4. The args array is logged as JSON before the call so you can copy-paste
//    it for local reproduction.
//
// spawn() is used — no shell is involved. Each array element is passed as a
// raw argv entry to the ffmpeg binary via execvp(). Parentheses, quotes,
// spaces, etc. are all inert.

function runFFmpeg(args, jobId, label) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}]   [${label}] Starting ffmpeg`);
    console.log(`[${jobId}]   [${label}] Args (${args.length} elements):`);
    console.log(`[${jobId}]   [${label}] ${JSON.stringify(args)}`);

    const ffmpegStart = Date.now();

    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    // Stream stdout to console line by line
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      text.split("\n").filter(Boolean).forEach((line) => {
        console.log(`[${jobId}]   [${label}:out] ${line}`);
      });
    });

    // Stream stderr to console line by line
    // FFmpeg sends all progress/diagnostic output to stderr, including
    // non-error info like encoding speed. This is expected and useful.
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      text.split("\n").filter(Boolean).forEach((line) => {
        console.error(`[${jobId}]   [${label}:err] ${line}`);
      });
    });

    // Hard timeout: 10 minutes
    const timeout = setTimeout(() => {
      console.error(`[${jobId}]   [${label}] ✗ TIMEOUT after 10 minutes — killing`);
      proc.kill("SIGKILL");
    }, 600_000);

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      const elapsed = ((Date.now() - ffmpegStart) / 1000).toFixed(1);

      if (code === 0) {
        console.log(
          `[${jobId}]   [${label}] ✓ Finished in ${elapsed}s (exit 0)`
        );
        resolve({ stdout, stderr });
      } else {
        console.error(
          `[${jobId}]   [${label}] ✗ FAILED in ${elapsed}s ` +
            `(exit ${code}, signal ${signal})`
        );
        console.error(
          `[${jobId}]   [${label}] Full stderr (${stderr.length} chars):`
        );
        console.error(stderr);

        const err = new Error(
          `FFmpeg [${label}] exited with code ${code} (signal: ${signal})`
        );
        // Attach diagnostic fields so the route handler can include them
        // in the API response for n8n to display.
        err.ffmpegStderr = stderr;
        err.ffmpegExitCode = code;
        err.ffmpegSignal = signal;
        reject(err);
      }
    });

    proc.on("error", (spawnErr) => {
      clearTimeout(timeout);
      console.error(
        `[${jobId}]   [${label}] ✗ spawn() error: ${spawnErr.message}`
      );

      const err = new Error(
        `Failed to start ffmpeg [${label}]: ${spawnErr.message}`
      );
      err.ffmpegStderr = stderr;
      err.ffmpegExitCode = null;
      err.ffmpegSignal = null;
      reject(err);
    });
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Instagram Reel Generator API (v3 — debug build)`);
  console.log(`   Listening on ${HOST}:${PORT}`);
  console.log(`   BASE_URL:          ${BASE_URL}`);
  console.log(`   OUTPUTS_DIR:       ${OUTPUTS_DIR}`);
  console.log(`   TEMP_ROOT:         ${TEMP_ROOT}`);
  console.log(`   MAX_CONCURRENT:    ${MAX_CONCURRENT_JOBS}`);
  console.log(`   Drawtext overlay:  DISABLED (debug mode)`);
  console.log(`\n   POST ${BASE_URL}/render`);
  console.log(`   GET  ${BASE_URL}/health\n`);
});