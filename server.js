import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ponytail: stdlib static server, no express/serve/nginx. Add CDN/nginx when traffic demands.
const root = path.resolve("dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      let p = path.normalize(path.join(root, url.pathname));
      if (!p.startsWith(root)) p = root;
      try {
        const data = await readFile(p === root ? path.join(root, "index.html") : p);
        res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
        res.end(data);
      } catch {
        const data = await readFile(path.join(root, "index.html")); // SPA fallback
        res.writeHead(200, { "content-type": "text/html" });
        res.end(data);
      }
    } catch {
      res.writeHead(500).end();
    }
  })
  .listen(process.env.PORT || 8080);
