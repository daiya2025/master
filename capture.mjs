import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PORT = 4173;
const TILESET_URL = "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-2025/tileset.json";
const RECORDING_SECONDS = 61;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".b3dm": "application/octet-stream",
  ".pnts": "application/octet-stream",
  ".cmpt": "application/octet-stream",
  ".i3dm": "application/octet-stream"
};

function safeLocalPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = path.normalize(decoded === "/" ? "/capture.html" : decoded).replace(/^([.][.][/\\])+/, "");
  const full = path.resolve(ROOT, `.${normalized.startsWith("/") ? normalized : `/${normalized}`}`);
  if (!full.startsWith(ROOT)) throw new Error("Path traversal rejected");
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    const filePath = safeLocalPath(req.url || "/");
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(data);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Not found: ${String(error)}`);
  }
});

async function listen() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
}

async function probeTileset() {
  const response = await fetch(TILESET_URL, {
    headers: { "User-Agent": "PLATEAU-Chiyoda-LOD2-Capture/1.0" },
    redirect: "follow"
  });
  const body = await response.text();
  await fs.writeFile("tileset-probe.json", body);
  if (!response.ok) {
    throw new Error(`Tileset probe failed: HTTP ${response.status} ${response.statusText}`);
  }
  const parsed = JSON.parse(body);
  const summary = {
    url: TILESET_URL,
    httpStatus: response.status,
    assetVersion: parsed?.asset?.version ?? null,
    geometricError: parsed?.geometricError ?? null,
    rootRefine: parsed?.root?.refine ?? null,
    rootContentUri: parsed?.root?.content?.uri ?? parsed?.root?.content?.url ?? null,
    rootChildren: Array.isArray(parsed?.root?.children) ? parsed.root.children.length : 0
  };
  await fs.writeFile("tileset-probe-summary.json", JSON.stringify(summary, null, 2));
  console.log("Tileset probe:", summary);
}

let browser;
let context;
let page;
const consoleLines = [];
const requestFailures = [];

try {
  await probeTileset();
  await listen();
  console.log(`Static server listening on http://127.0.0.1:${PORT}`);

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--hide-scrollbars",
      "--window-size=1920,1080"
    ]
  });

  context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: "light",
    acceptDownloads: true
  });

  page = await context.newPage();
  page.setDefaultTimeout(300000);
  page.setDefaultNavigationTimeout(300000);

  page.on("console", message => {
    const line = `[console:${message.type()}] ${message.text()}`;
    consoleLines.push(line);
    console.log(line);
  });
  page.on("pageerror", error => {
    const line = `[pageerror] ${error.stack || error.message || String(error)}`;
    consoleLines.push(line);
    console.error(line);
  });
  page.on("requestfailed", request => {
    const line = `${request.failure()?.errorText || "request failed"} ${request.url()}`;
    requestFailures.push(line);
    if (request.url().includes("plateau") || request.url().includes("cesium")) console.warn(`[requestfailed] ${line}`);
  });
  page.on("response", response => {
    const url = response.url();
    if ((url.includes("plateau") || url.includes("reearth")) && response.status() >= 400) {
      const line = `[http ${response.status()}] ${url}`;
      consoleLines.push(line);
      console.warn(line);
    }
  });

  await page.goto(`http://127.0.0.1:${PORT}/capture.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__ready || window.__loadError));

  const loadError = await page.evaluate(() => window.__loadError || null);
  if (loadError) throw new Error(`Page reported tileset error: ${loadError}`);

  console.log("LOD2 root tileset loaded; preloading camera destinations.");
  await page.evaluate(() => window.preloadWaypoints());
  await page.waitForFunction(() => window.__preloaded === true);
  await page.screenshot({ path: "qc-loaded.png", type: "png" });
  await page.waitForTimeout(800);

  const captureStartedAt = new Date();
  console.log("Starting synchronized Cesium canvas recording and camera tour.");
  const downloadPromise = page.waitForEvent("download", { timeout: 240000 });
  const recordingResultPromise = page.evaluate(async recordingSeconds => {
    const canvas = document.querySelector("#cesiumContainer canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Cesium render canvas not found");
    if (typeof canvas.captureStream !== "function") throw new Error("canvas.captureStream is unavailable");
    if (typeof MediaRecorder !== "function") throw new Error("MediaRecorder is unavailable");

    const mimeType = [
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/webm"
    ].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("No supported WebM MediaRecorder codec");

    const stream = canvas.captureStream(30);
    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 16_000_000
    });
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.addEventListener("error", event => reject(event.error || new Error("MediaRecorder error")), { once: true });
    });
    recorder.addEventListener("dataavailable", event => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });

    recorder.start(1000);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const tourStartedAt = performance.now();
    const tourPromise = window.startTour();
    await new Promise(resolve => setTimeout(resolve, recordingSeconds * 1000));
    recorder.stop();
    await stopped;
    const recordingStoppedAt = performance.now();
    await tourPromise;

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size < 1_000_000) throw new Error(`Recorded WebM is unexpectedly small: ${blob.size} bytes`);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "raw-tour.webm";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    stream.getTracks().forEach(track => track.stop());

    return {
      mimeType,
      bytes: blob.size,
      recordingMilliseconds: recordingStoppedAt - tourStartedAt,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height
    };
  }, RECORDING_SECONDS);

  const [download, recordingResult] = await Promise.all([downloadPromise, recordingResultPromise]);
  await download.saveAs("raw-tour.webm");
  await page.screenshot({ path: "qc-final.png", type: "png" });

  const captureFinishedAt = new Date();
  const meta = {
    source: TILESET_URL,
    rendering: "CesiumJS direct 3D Tiles display; no geometry or color styling applied",
    recordingMethod: "HTMLCanvasElement.captureStream plus MediaRecorder after all camera destinations were preloaded",
    viewport: "1920x1080",
    outputSecondsRequested: 60,
    rawRecordingSecondsRequested: RECORDING_SECONDS,
    captureStartedAt: captureStartedAt.toISOString(),
    captureFinishedAt: captureFinishedAt.toISOString(),
    recordingResult,
    requestFailureCount: requestFailures.length
  };
  await fs.writeFile("capture-meta.json", JSON.stringify(meta, null, 2));
  await fs.writeFile("browser-console.log", consoleLines.join("\n") + "\n");
  await fs.writeFile("request-failures.log", requestFailures.join("\n") + "\n");
  console.log("Synchronized LOD2 canvas capture complete.", recordingResult);
} catch (error) {
  console.error(error?.stack || error);
  await fs.writeFile("capture-error.txt", String(error?.stack || error));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await new Promise(resolve => server.close(() => resolve()));
}
