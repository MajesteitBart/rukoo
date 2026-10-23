// Serves the APKs in android/artifacts/ (and its android-v*/ folders) so a phone on the tailnet can download them.
// Usage: node tools/serve-apk.mjs <bind address, e.g. this PC's Tailscale IP> [port=8787]
// Adapted from dudan's tools/serve-apk.mjs (MIT, Bart van der Meeren).
import http from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 8787);
const dir = resolve(fileURLToPath(new URL("../artifacts", import.meta.url)));

// Newest first, as paths relative to artifacts/ with forward slashes.
function apks() {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".apk")) found.push(entry.name);
    if (entry.isDirectory()) {
      for (const f of readdirSync(join(dir, entry.name))) if (f.endsWith(".apk")) found.push(`${entry.name}/${f}`);
    }
  }
  return found.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
}

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

http
  .createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1));
    if (name === "" || name === "index.html") {
      const links = apks()
        .map((f) => `<li><a href="/${f.split("/").map(encodeURIComponent).join("/")}">${escape(f)}</a> (${(statSync(join(dir, f)).size / 1e6).toFixed(1)} MB)</li>`)
        .join("");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta name=viewport content="width=device-width"><title>Rukoo for Android</title>` +
          `<body style="font-family:sans-serif;background:#111;color:#eee;padding:24px"><h2>Rukoo for Android</h2><ul>${links || "<li>No APKs in artifacts/ yet.</li>"}</ul></body>`,
      );
      return;
    }
    // Only names the listing offers, so a crafted path can't leave artifacts/.
    if (!apks().includes(name) || relative(dir, join(dir, name)).split(sep).includes("..")) {
      res.writeHead(404).end("not found");
      return;
    }
    const file = join(dir, name);
    res.writeHead(200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": statSync(file).size,
      "Content-Disposition": `attachment; filename="${name.split("/").pop()}"`,
    });
    createReadStream(file).pipe(res);
  })
  .listen(port, host, () => console.log(`serving ${dir} on http://${host}:${port}`));
