import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PORT = 4173;
const TILESET_URL = "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-2025/tileset.json";

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
    recordVideo: {
      dir: "videos",
      size: { width: 1920, height: 1080 }
    }
  });

  const pageCreatedAt = Date.now();
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
  await page.waitForTimeout(1200);

  const tourStartedAt = Date.now();
  const preRollSeconds = Math.max(0, (tourStartedAt - pageCreatedAt) / 1000 - 0.35);
  console.log(`Tour starting; trim offset ${preRollSeconds.toFixed(3)} seconds.`);
  await page.evaluate(() => window.startTour());
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "qc-final.png", type: "png" });

  const video = page.video();
  await page.close();
  await context.close();
  await video.saveAs("raw-capture.webm");

  const meta = {
    source: TILESET_URL,
    rendering: "CesiumJS direct 3D Tiles display; no geometry or color styling applied",
    viewport: "1920x1080",
    tourSecondsRecorded: 64,
    outputSecondsRequested: 60,
    preRollSeconds,
    pageCreatedAt: new Date(pageCreatedAt).toISOString(),
    tourStartedAt: new Date(tourStartedAt).toISOString(),
    requestFailureCount: requestFailures.length
  };
  await fs.writeFile("capture-meta.json", JSON.stringify(meta, null, 2));
  await fs.writeFile("browser-console.log", consoleLines.join("\n") + "\n");
  await fs.writeFile("request-failures.log", requestFailures.join("\n") + "\n");
  console.log("Capture complete.");
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
