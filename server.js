// Hararu 本地音乐播放器 —— 独立单机版 (去掉 PakePlus 壳，直接用浏览器打开)
// Node.js 18+
// 启动：node server.js  然后浏览器访问 http://127.0.0.1:8787/
//
// 提供：
//   /                       -> 播放器页面 index.html
//   /api/list-audio?dir=    -> 列出目录下的音频文件
//   /api/audio?file=        -> 流式读取音频文件（支持 Range，用于拖动进度）
//   /api/list-images?dir=   -> 列出目录下的图片文件
//   /api/image?file=        -> 读取图片文件
//   /api/proxy?url=&referer= -> 代理远程图片 API（解决浏览器跨域）
//   /api/save-path          -> POST 记忆路径配置 (session.json)
//   /api/load-path          -> 读取记忆的路径配置

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, "session.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "127.0.0.1" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

// 远程代理：只允许公网 http/https，拒绝内网与 localhost（避免变成开放代理）
async function proxy(req, res, targetUrl, referer) {
  let target;
  try { target = new URL(targetUrl); } catch { return send(res, 400, "Invalid target URL"); }
  if (!["http:", "https:"].includes(target.protocol)) return send(res, 400, "Only http/https URLs are allowed");
  if (isPrivateHostname(target.hostname)) return send(res, 403, "Private/local target is blocked");
  try {
    const headers = {
      "User-Agent": "Hararu-Music-Player/1.0",
      "Accept": "application/json,image/*,*/*;q=0.8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
    };
    if (referer) headers["Referer"] = referer;
    const upstream = await fetch(target, { method: "GET", redirect: "follow", headers, signal: AbortSignal.timeout(15000) });
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end(buffer);
  } catch (error) {
    console.error("[proxy]", target.href, error.message);
    send(res, 502, `Proxy request failed: ${error.message}`);
  }
}

// 递归列出某个目录下指定扩展名的文件
function listFiles(dir, extSet) {
  const files = [];
  function walk(dirPath, rel) {
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      const relPath = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, relPath);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extSet.has(ext)) {
          const s = fs.statSync(full);
          files.push({ name: entry.name, path: full, relPath, size: s.size, lastModified: s.mtimeMs });
        }
      }
    }
  }
  walk(dir, "");
  return files;
}

// 支持 Range 请求的流式文件读取
function streamFile(req, res, filePath, contentType) {
  const s = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : s.size - 1;
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end >= s.size) end = s.size - 1;
    if (start > end) return send(res, 416, "", { "Content-Range": `bytes */${s.size}` });
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${s.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": s.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  console.log("__REQ__ " + req.method + " " + req.url + " from " + (req.headers.referer || "no-referer"));
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);

  if (req.method === "OPTIONS") {
    return send(res, 204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Origin",
      "Access-Control-Max-Age": "86400",
    });
  }

  if (url.pathname === "/api/proxy") {
    const target = url.searchParams.get("url");
    const referer = url.searchParams.get("referer") || "";
    if (!target) return send(res, 400, "Missing ?url=");
    return proxy(req, res, target, referer);
  }

  if (url.pathname === "/api/save-path" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        // 防止空路径覆盖已记住的路径（避免客户端在路径未恢复时误清空）
        let next = null;
        try { next = JSON.parse(body); } catch (_) {}
        if (next && typeof next === "object") {
          let prev = {};
          try { prev = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch (_) {}
          if (!next.musicFolder && prev.musicFolder) next.musicFolder = prev.musicFolder;
          if (!next.coverFolder && prev.coverFolder) next.coverFolder = prev.coverFolder;
          body = JSON.stringify(next);
        }
        fs.writeFileSync(CONFIG_FILE, body, "utf-8");
        send(res, 200, "ok", { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      } catch (e) {
        send(res, 500, "Save failed: " + e.message, { "Access-Control-Allow-Origin": "*" });
      }
    });
    return;
  }

  if (url.pathname === "/api/load-path") {
    try {
      const data = fs.readFileSync(CONFIG_FILE, "utf-8");
      if (!data || !data.trim()) return send(res, 200, "{}", { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      send(res, 200, data, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    } catch {
      send(res, 200, "{}", { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    }
    return;
  }

  if (url.pathname === "/api/list-audio") {
    const dir = url.searchParams.get("dir");
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (!dir) return send(res, 400, "Missing ?dir=", cors);
    try {
      if (!fs.statSync(dir).isDirectory()) return send(res, 400, "Not a directory", cors);
      const extSet = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac"]);
      send(res, 200, JSON.stringify({ folder: dir, files: listFiles(dir, extSet) }), { "Content-Type": "application/json", ...cors });
    } catch (e) {
      send(res, 500, "List failed: " + e.message, cors);
    }
    return;
  }

  if (url.pathname === "/api/audio") {
    const filePath = url.searchParams.get("file");
    if (!filePath) return send(res, 400, "Missing ?file=", { "Access-Control-Allow-Origin": "*" });
    try {
      if (!fs.statSync(filePath).isFile()) return send(res, 404, "Not Found");
      const ext = path.extname(filePath).toLowerCase();
      return streamFile(req, res, filePath, MIME[ext] || "application/octet-stream");
    } catch { send(res, 404, "Not Found"); }
    return;
  }

  if (url.pathname === "/api/list-images") {
    const dir = url.searchParams.get("dir");
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (!dir) return send(res, 400, "Missing ?dir=", cors);
    try {
      if (!fs.statSync(dir).isDirectory()) return send(res, 400, "Not a directory", cors);
      const extSet = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".avif"]);
      send(res, 200, JSON.stringify({ folder: dir, files: listFiles(dir, extSet) }), { "Content-Type": "application/json", ...cors });
    } catch (e) {
      send(res, 500, "List failed: " + e.message, cors);
    }
    return;
  }

  if (url.pathname === "/api/image") {
    const filePath = url.searchParams.get("file");
    if (!filePath) return send(res, 400, "Missing ?file=", { "Access-Control-Allow-Origin": "*" });
    try {
      if (!fs.statSync(filePath).isFile()) return send(res, 404, "Not Found");
      const ext = path.extname(filePath).toLowerCase();
      return streamFile(req, res, filePath, MIME[ext] || "application/octet-stream");
    } catch { send(res, 404, "Not Found"); }
    return;
  }

  // 本地随机图片：从记忆的封面文件夹里挑一张随机图片返回。
  // 用途：封面"API 图片"模式在远程 API 失效时的兜底，保证随机图永远可用。
  if (url.pathname === "/api/random-image") {
    const cors = { "Access-Control-Allow-Origin": "*" };
    let dir = url.searchParams.get("dir") || "";
    if (!dir) {
      try {
        const data = fs.readFileSync(CONFIG_FILE, "utf-8");
        const cfg = JSON.parse(data);
        dir = (cfg && cfg.coverFolder) || "";
      } catch (_) { }
    }
    if (!dir) return send(res, 400, "No cover folder configured (请先设置封面文件夹)", cors);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) return send(res, 400, "Cover folder not a directory", cors);
      const extSet = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".avif"]);
      const files = listFiles(dir, extSet);
      if (!files.length) return send(res, 404, "No images in cover folder", cors);
      const pick = files[Math.floor(Math.random() * files.length)];
      const m = MIME[path.extname(pick.path).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": m,
        "Content-Length": String(pick.size),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Random-Image": encodeURIComponent(pick.relPath),
      });
      fs.createReadStream(pick.path).pipe(res);
    } catch (e) {
      send(res, 500, "Random image failed: " + e.message, cors);
    }
    return;
  }

  // 静态文件（默认 index.html）
  let filePath = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden");
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return send(res, 404, "Not Found");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    send(res, 404, "Not Found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Hararu player running at http://${HOST}:${PORT}/`);
  console.log(`API proxy: http://${HOST}:${PORT}/api/proxy?url=<encoded-url>`);
  console.log(`Local audio:  http://${HOST}:${PORT}/api/list-audio?dir=<folder>`);
});
