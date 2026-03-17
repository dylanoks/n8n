// ─────────────────────────────────────────────────────────────────────────────
// server.js — Instagram Reel Generator API
// ─────────────────────────────────────────────────────────────────────────────
// Accepts a source video URL + audio URL + text phrase, randomly extracts N
// clips, concatenates them, converts to 1080×1920 vertical, overlays text,
// replaces audio, and returns a public MP4 URL.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { execSync, exec } = require("child_process");
const util = require("util");

const execAsync = util.promisify(exec);

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

function checkDependencies() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    execSync("ffprobe -version", { stdio: "ignore" });
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
      // Random float in [0, maxStart] rounded to 3 decimal places
      const t = +(Math.random() * maxStart).toFixed(3);
      startTimes.push(t);
    }
    console.log(`  ✂ Random start times: [${startTimes.join(", ")}]`);

    // ── 8. Extract individual clips ────────────────────────────────────────

    const clipPaths = [];
    for (let i = 0; i < clipCount; i++) {
      const clipPath = path.join(jobDir, `clip_${String(i).padStart(3, "0")}.mp4`);
      clipPaths.push(clipPath);

      // -ss before -i for fast seeking; -t trims the clip length.
      // We re-encode to ensure uniform codec/timebase across all clips so
      // that the later concat demuxer works reliably.
      await runFFmpeg([
        "-ss", String(startTimes[i]),
        "-i", sourceVideoPath,
        "-t", String(clipDuration),
        "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-an",                 // strip audio — we'll add our own later
        "-r", "30",            // normalize frame rate
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

    // Build the text overlay filter.
    // Escapes colons and backslashes which are special in drawtext.
    const safePhrase = phrase
      .replace(/\\/g, "\\\\\\\\")
      .replace(/'/g, "'\\''")
      .replace(/:/g, "\\:");

    // Font selection — tries common system fonts with a safe fallback.
    const fontFile = pickFont();

    // Audio handling:
    //   • -stream_loop -1 loops the audio if it's shorter than the video
    //   • -t trims it to exactly finalDuration seconds
    //   • -shortest would also work but explicit -t is more predictable

    const actualFinalDuration = +(clipCount * clipDuration).toFixed(2);
    const outputFilename = `reel_${jobId}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);

    await runFFmpeg([
      "-i", concatenatedPath,
      "-stream_loop", "-1",
      "-i", audioPath,
      "-t", String(actualFinalDuration),
      "-vf", [
        // Ensure final dimensions are exactly right (should already be, but safety net)
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
        `setsar=1`,
        // Bold readable text overlay — centered, white with black outline
        `drawtext=` +
          (fontFile ? `fontfile='${fontFile}':` : "") +
          `text='${safePhrase}':` +
          `fontsize=52:` +
          `fontcolor=white:` +
          `borderw=3:` +
          `bordercolor=black:` +
          `shadowcolor=black@0.5:` +
          `shadowx=2:` +
          `shadowy=2:` +
          `x=(w-text_w)/2:` +
          `y=(h-text_h)/2`,
      ].join(","),
      "-map", "0:v:0",        // video from concatenated file
      "-map", "1:a:0",        // audio from provided audio file
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-r", "30",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",   // enables progressive download / streaming
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

// ─── Helper: download a remote file to disk ──────────────────────────────────

async function downloadFile(url, destPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120_000,        // 2 min timeout
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
        reject(new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} bytes limit.`));
      }
    });
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// ─── Helper: get video duration via ffprobe ──────────────────────────────────

async function getVideoDuration(filePath) {
  // ffprobe outputs just the duration in seconds as a plain number
  const cmd = [
    "ffprobe",
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    `"${filePath}"`,
  ].join(" ");

  const { stdout } = await execAsync(cmd);
  const duration = parseFloat(stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    throw new Error("Could not determine source video duration via ffprobe.");
  }
  return duration;
}

// ─── Helper: run an ffmpeg command from an args array ─────────────────────────

async function runFFmpeg(args) {
  const cmd = "ffmpeg " + args.map((a) => {
    // Wrap paths/values that contain spaces in quotes
    if (a.includes(" ") && !a.startsWith("'") && !a.startsWith('"')) {
      return `"${a}"`;
    }
    return a;
  }).join(" ");

  try {
    await execAsync(cmd, {
      // FFmpeg can be verbose; increase buffer to avoid truncation
      maxBuffer: 50 * 1024 * 1024,
      timeout: 600_000,   // 10 min hard timeout per ffmpeg call
    });
  } catch (err) {
    // err.stderr usually has the ffmpeg error details
    const detail = err.stderr
      ? err.stderr.split("\n").slice(-6).join("\n")
      : err.message;
    throw new Error(`FFmpeg failed:\n${detail}`);
  }
}

// ─── Helper: pick a readable font file ───────────────────────────────────────

function pickFont() {
  // Common font paths across Linux distributions and macOS.
  // The first one found wins.  If none exist, ffmpeg's built-in
  // default font will be used (less pretty but functional).
  const candidates = [
    // Ubuntu / Debian
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
