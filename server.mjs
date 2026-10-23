// The extension's process: COGNIX[WS] posts a call to one of its tools here
// (door I) and the tool reaches the Penpot server back through COGNIX[WS],
// which fills the server's address and key; this process never holds them.
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { importImage, ArgError } from "./import.mjs";

const env = process.env;

// hostBase is COGNIX[WS]'s address, on loopback only.
function hostBase() {
  const base = new URL(env.PICODE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("PiCode Host API must use loopback.");
  return base;
}

function equal(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// upstreamCall sends one MCP request to the call's server through COGNIX[WS].
export function upstreamCall(upstream, method, params) {
  return new Promise((resolve, reject) => {
    const target = new URL(upstream.path, hostBase());
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, {
      method: "POST",
      rejectUnauthorized: false, // PiCode's own certificate, on loopback only
      headers: { "X-PiCode-Extension-Token": env.PICODE_EXT_TOKEN, [upstream.header]: upstream.call, "Content-Type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (b) => chunks.push(b));
      res.on("error", reject);
      res.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { body = {}; }
        if (res.statusCode !== 200) return reject(new Error(body.error || `COGNIX[WS] answered HTTP ${res.statusCode}`));
        if (body.error) return reject(new Error(body.error));
        resolve(body.result);
      });
    });
    req.setTimeout(150_000, () => req.destroy(new Error("COGNIX[WS] did not answer in time")));
    req.on("error", reject);
    req.end(JSON.stringify({ method, params }));
  });
}

// executor runs code in the Penpot tab: Penpot answers a refused execution
// with a normal result whose text starts "Tool execution failed".
export function executor(upstream, call = upstreamCall) {
  return async (code) => {
    const res = await call(upstream, "tools/call", { name: "execute_code", arguments: { code } });
    const text = (res?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res?.isError || text.startsWith("Tool execution failed")) throw new Error(text || "Penpot refused the code");
    let out;
    try { out = JSON.parse(text); } catch { throw new Error("Penpot's answer could not be read"); }
    return out.result;
  };
}

// answer is one call of an added tool, as a tool result.
export async function answer(call, run = importImage) {
  const text = (t) => [{ type: "text", text: t }];
  if (call?.tool !== "import_image") return { isError: true, content: text(`${call?.tool} is not a tool of this extension`) };
  try {
    const out = await run(call.arguments, executor(call.upstream));
    return { content: text(JSON.stringify(out)) };
  } catch (err) {
    if (err instanceof ArgError) return { isError: true, content: text(err.message) };
    return { isError: true, content: text(`The picture did not reach Penpot: ${err.message}. Check that the Penpot tab is open and its MCP button reads MCP connected.`) };
  }
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!equal(req.headers["x-picode-proxy-secret"], env.PICODE_EXT_PROXY_SECRET)) return send(403, { error: "Use the PiCode process relay." });
  if (req.method !== "POST" || req.url !== "/mcp-tools/call") return send(404, { error: "not found" });
  const chunks = [];
  let size = 0;
  req.on("data", (b) => {
    size += b.length;
    if (size > 1 << 20) req.destroy();
    else chunks.push(b);
  });
  req.on("end", async () => {
    let call;
    try { call = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: "not JSON" }); }
    send(200, await answer(call));
  });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(Number(env.PICODE_EXT_PORT), "127.0.0.1");
}
