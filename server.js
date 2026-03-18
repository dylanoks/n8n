// ─────────────────────────────────────────────────────────────────────────────
// server.js — Instagram Reel Generator API (v2 — shell-safe)
// ─────────────────────────────────────────────────────────────────────────────
// FIX: All FFmpeg/FFprobe calls now use child_process.spawn / execFileSync
// with argument arrays instead of exec(). This bypasses /bin/sh entirely,
// so filter expressions containing parentheses like (ow-iw)/2 are passed
// as raw strings directly to the ffmpeg binary — no shell interpretation.
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

// Base URL used to build the public download link.
// In production set this to your deployment URL, e.g. https://my-app.onrender.com
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Directory where finished MP4s are served from
const OUTPUTS_DIR = path.join(__dirname, "outputs");

// Root directory for per-job temp files
const TEMP_ROOT = path.join(__dirname, "tmp");

// Max download size (500 MB) — guards against runaway downloads
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

// Max concurrent jobs (simple in-memory semaphore)
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 3;
let activeJobs = 0;

// ─── Ensure directories exist ────────────────────────────────────────────────

fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
fs.mkdirSync(TEMP_ROOT, { recursive: true });

// ─── Verify ffmpeg / ffprobe are available ───────────────────────────────────
// Uses execFileSync — runs the binary directly, no shell involved.

function checkDependencies() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    console.log("✓ ffmpeg and ffprobe found");
  } catch {
    console.error(
      "✗ ffmpeg or ffprobe not found. Install them before running this server.\n" +
        "  On Ubuntu/Debian: sudo apt-get install ffmpeg\n" +
        "  On macOS:         brew install ffmpeg"
    );
    process.exit(1);
  }
}

checkDependencies();

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Serve finished videos as static files at /outputs/<filename>.mp4
app.use("/outputs", express.static(OUTPUTS_DIR));

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", activeJobs });
});

// ─── POST /render ────────────────────────────────────────────────────────────

app.post("/render", async (req, res) => {
  // ── 1. Validate input ────────────────────────────────────────────────────

  const {
    sourceVideoUrl,
    audioUrl,
    phrase,
    clipCount = 10,
    clipDuration = 0.8,
    finalDuration = 8,
    width = 1080,
    height = 1920,
  } = req.body;

  if (!sourceVideoUrl || !audioUrl || !phrase) {
    return res.status(400).json({
      success: false,
      error:
        "Missing required fields: sourceVideoUrl, audioUrl, and phrase are all required.",
    });
  }

  if (clipCount < 1 || clipCount > 100) {
    return res.status(400).json({
      success: false,
      error: "clipCount must be between 1 and 100.",
    });
  }

  const expectedDuration = +(clipCount * clipDuration).toFixed(2);
  if (Math.abs(expectedDuration - finalDuration) > 0.01) {
    console.warn(
      `⚠ clipCount × clipDuration (${expectedDuration}s) ≠ finalDuration (${finalDuration}s). ` +
        `The actual output length will be ${expectedDuration}s.`
    );
  }

  // ── 2. Concurrency guard ─────────────────────────────────────────────────

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({
      success: false,
      error: `Server busy — ${activeJobs} jobs running. Try again shortly.`,
    });
  }

  activeJobs++;

  // ── 3. Create a unique temp directory for this job ────────────────────────

  const jobId = uuidv4();
  const jobDir = path.join(TEMP_ROOT, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`\n🎬 Job ${jobId} started`);

  try {
    // ── 4. Download source video ───────────────────────────────────────────

    const sourceVideoPath = path.join(jobDir, "source_video.mp4");
    console.log("  ↓ Downloading source video …");
    await downloadFile(sourceVideoUrl, sourceVideoPath);
    console.log("  ✓ Source video downloaded");

    // ── 5. Download audio file ─────────────────────────────────────────────

    const audioPath = path.join(jobDir, "audio_input.mp3");
    console.log("  ↓ Downloading audio …");
    await downloadFile(audioUrl, audioPath);
    console.log("  ✓ Audio downloaded");

    // ── 6. Probe video duration ────────────────────────────────────────────

    const videoDuration = await getVideoDuration(sourceVideoPath);
    console.log(`  ℹ Source video duration: ${videoDuration}s`);

    if (videoDuration < clipDuration) {
      throw new Error(
        `Source video is too short (${videoDuration}s). ` +
          `Need at least ${clipDuration}s to extract a clip.`
      );
    }

    // ── 7. Pick random start times ─────────────────────────────────────────

    const maxStart = videoDuration - clipDuration;
    const startTimes = [];
    for (let i = 0; i < clipCount; i++) {
      const t = +(Math.random() * maxStart).toFixed(3);
      startTimes.push(t);
    }
    console.log(`  ✂ Random start times: [${startTimes.join(", ")}]`);

    // ── 8. Extract individual clips ────────────────────────────────────────

    // The -vf filter contains parentheses like (ow-iw)/2.
    // With spawn(), these are passed as a raw string directly to the ffmpeg
    // binary — the shell never sees them.
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

      await runFFmpeg([
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
    }
    console.log(`  ✓ ${clipCount} clips extracted`);

    // ── 9. Build concat file list ──────────────────────────────────────────

    const concatListPath = path.join(jobDir, "concat_list.txt");
    const concatListContent = clipPaths
      .map((p) => `file '${p}'`)
      .join("\n");
    fs.writeFileSync(concatListPath, concatListContent);

    // ── 10. Concatenate clips ──────────────────────────────────────────────

    const concatenatedPath = path.join(jobDir, "concatenated.mp4");
    await runFFmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-y",
      concatenatedPath,
    ]);
    console.log("  ✓ Clips concatenated");

    // ── 11. Overlay text + replace audio → final output ────────────────────

    // Build the drawtext filter value.
    // Only FFmpeg-level escapes needed (colons and backslashes).
    // No shell escapes needed because spawn() never invokes a shell.
    const ffmpegSafePhrase = phrase
      .replace(/\\/g, "\\\\")       // escape backslashes for ffmpeg
      .replace(/:/g, "\\:")          // escape colons for ffmpeg drawtext
      .replace(/'/g, "'\\''");       // escape single quotes for ffmpeg

    const fontFile = pickFont();

    // Build the complete -vf filter chain as ONE string.
    // spawn() passes this as a single argv element to ffmpeg.
    const fontClause = fontFile ? `fontfile='${fontFile}':` : "";
    const videoFilter = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      `setsar=1`,
      `drawtext=${fontClause}` +
        `text='${ffmpegSafePhrase}':` +
        `fontsize=52:` +
        `fontcolor=white:` +
        `borderw=3:` +
        `bordercolor=black:` +
        `shadowcolor=black@0.5:` +
        `shadowx=2:` +
        `shadowy=2:` +
        `x=(w-text_w)/2:` +
        `y=(h-text_h)/2`,
    ].join(",");

    const actualFinalDuration = +(clipCount * clipDuration).toFixed(2);
    const outputFilename = `reel_${jobId}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);

    await runFFmpeg([
      "-i", concatenatedPath,
      "-stream_loop", "-1",
      "-i", audioPath,
      "-t", String(actualFinalDuration),
      "-vf", videoFilter,
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
    console.log("  ✓ Final render complete");

    // ── 12. Build public URL & respond ─────────────────────────────────────

    const finalMp4Url = `${BASE_URL}/outputs/${outputFilename}`;

    console.log(`  🔗 ${finalMp4Url}`);
    console.log(`✅ Job ${jobId} finished\n`);

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
      },
    });
  } catch (err) {
    console.error(`✗ Job ${jobId} failed:`, err.message);
    return res.status(500).json({
      success: false,
      jobId,
      error: err.message,
    });
  } finally {
    // ── 13. Cleanup temp directory ─────────────────────────────────────────
    activeJobs--;
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
      console.log(`  🧹 Cleaned up temp dir for job ${jobId}`);
    } catch (cleanupErr) {
      console.warn(`  ⚠ Cleanup failed for ${jobId}:`, cleanupErr.message);
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
  });

  const writer = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    let bytes = 0;
    response.data.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) {
        writer.destroy();
        reject(
          new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} bytes limit.`)
        );
      }
    });
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: get video duration via ffprobe
// ─────────────────────────────────────────────────────────────────────────────
// FIXED: was exec() with a shell string — now execFileSync with args array.
// The file path is passed as a raw argument, not quoted inside a string.

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const stdout = execFileSync("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ], {
        encoding: "utf-8",
        timeout: 30_000,
      });

      const duration = parseFloat(stdout.trim());
      if (isNaN(duration) || duration <= 0) {
        reject(new Error("ffprobe returned a non-numeric duration."));
      } else {
        resolve(duration);
      }
    } catch (err) {
      reject(
        new Error(
          `Could not determine video duration via ffprobe: ${err.message}`
        )
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: run FFmpeg
// ─────────────────────────────────────────────────────────────────────────────
// FIXED — this was the root cause of the Railway crash.
//
// BEFORE (broken):
//   const cmd = "ffmpeg " + args.join(" ");
//   await execAsync(cmd);
//
//   execAsync = util.promisify(exec) → exec runs commands through /bin/sh.
//   /bin/sh sees the filter string:
//     pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black
//   and interprets (ow-iw) as a subshell command → "Syntax error: ( unexpected"
//
// AFTER (fixed):
//   spawn("ffmpeg", args)
//
//   spawn() calls execvp() directly at the OS level.
//   Each element of args[] becomes one argv entry for the ffmpeg process.
//   No shell is involved. Parentheses, quotes, spaces, $, `, *, etc.
//   are all inert — they reach ffmpeg exactly as-is.

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    // Log for debugging — display-only quoting, not fed to any shell
    console.log(
      `    ▸ ffmpeg ${args.map((a) => (a.includes(" ") || a.includes("(")) ? JSON.stringify(a) : a).join(" ")}`
    );

    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Hard timeout: 10 minutes per ffmpeg call
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg timed out after 10 minutes."));
    }, 600_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
      } else {
        // Show last ~8 lines of stderr — that's where ffmpeg puts its errors
        const tail = stderr.split("\n").slice(-8).join("\n").trim();
        reject(new Error(`FFmpeg exited with code ${code}:\n${tail}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: pick a readable font file
// ─────────────────────────────────────────────────────────────────────────────

function pickFont() {
  const candidates = [
    // Ubuntu / Debian (including Railway's default Docker images)
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
      console.log(`  🔤 Using font: ${fp}`);
      return fp;
    }
  }

  console.warn("  ⚠ No preferred font found — using ffmpeg default font");
  return null;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Instagram Reel Generator API running at ${BASE_URL}`);
  console.log(`   POST ${BASE_URL}/render`);
  console.log(`   GET  ${BASE_URL}/health\n`);
});
