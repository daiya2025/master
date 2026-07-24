import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import process from "node:process";

const input = process.argv[2] || "raw-capture.webm";
const output = process.argv[3] || "sync-detection.json";
const fps = 30;

function decodeAveragePixels() {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-i", input,
      "-vf", `fps=${fps},scale=1:1:flags=area,format=rgb24`,
      "-f", "rawvideo",
      "pipe:1"
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg sync scan failed with code ${code}: ${Buffer.concat(errors).toString("utf8")}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function isMarkerPixel(r, g, b) {
  return g >= 190 && r <= 55 && b <= 55 && g - r >= 130 && g - b >= 130;
}

const pixels = await decodeAveragePixels();
if (pixels.length % 3 !== 0) throw new Error(`Unexpected RGB byte count: ${pixels.length}`);

const frameCount = pixels.length / 3;
let bestStart = -1;
let bestEnd = -1;
let runStart = -1;

for (let frame = 0; frame < frameCount; frame++) {
  const offset = frame * 3;
  const marker = isMarkerPixel(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
  if (marker && runStart < 0) runStart = frame;
  const runEnded = runStart >= 0 && (!marker || frame === frameCount - 1);
  if (runEnded) {
    const runEnd = marker && frame === frameCount - 1 ? frame : frame - 1;
    if (bestStart < 0 || runEnd - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = runEnd;
    }
    runStart = -1;
  }
}

const markerFrames = bestEnd >= bestStart && bestStart >= 0 ? bestEnd - bestStart + 1 : 0;
if (markerFrames < Math.round(fps * 0.75)) {
  throw new Error(`Synchronization marker was not detected reliably; longest run was ${markerFrames} frames`);
}

const trimFrame = Math.min(frameCount - 1, bestEnd + 1);
const trimSeconds = trimFrame / fps;
const report = {
  input,
  scanFps: fps,
  scannedFrames: frameCount,
  markerStartFrame: bestStart,
  markerEndFrame: bestEnd,
  markerFrames,
  markerStartSeconds: bestStart / fps,
  markerEndSeconds: bestEnd / fps,
  trimStartFrame: trimFrame,
  trimStartSeconds: trimSeconds
};

await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.error(`Detected full-frame green sync marker from ${report.markerStartSeconds.toFixed(3)}s to ${report.markerEndSeconds.toFixed(3)}s.`);
process.stdout.write(trimSeconds.toFixed(6));
