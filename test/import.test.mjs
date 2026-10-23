import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importImage, sniff, PIECE, ArgError } from "../import.mjs";
import { answer, executor } from "../server.mjs";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// fakeTab runs the code the way the Penpot plugin does: a function body with
// storage and penpot in scope, answering what it returns.
function fakeTab({ fail = {}, drop = -1 } = {}) {
  const tab = { storage: {}, uploads: [], shapes: [], calls: 0 };
  const penpot = {
    async uploadMediaData(name, bytes, mime) {
      tab.uploads.push({ name, bytes: Buffer.from(bytes), mime });
      return { width: 40, height: 30 };
    },
    createRectangle() {
      const r = { id: "shape-" + (tab.shapes.length + 1), resize(w, h) { r.w = w; r.h = h; } };
      tab.shapes.push(r);
      return r;
    },
  };
  tab.execute = async (code) => {
    tab.calls++;
    const piece = code.match(/\)\[(\d+)\] = "/);
    if (piece) {
      const i = Number(piece[1]);
      if (fail[i] > 0) {
        fail[i]--;
        throw new Error("Tool execution failed: Error: The Penpot plugin tab appears to be suspended");
      }
      if (i === drop) return i; // answered, but never stored
    }
    return new AsyncFunction("storage", "penpot", "atob", code)(tab.storage, penpot, atob);
  };
  return tab;
}

async function picture(dir, name, bytes) {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

const png = (size) => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 2654435761) >>> 13;
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
};

test("a picture travels in pieces, is assembled whole and fills one rectangle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penpot-"));
  const data = png(400 << 10);
  const path = await picture(dir, 'shot "one".png', data);
  const tab = fakeTab({ fail: { 2: 1 } });
  const out = await importImage({ filePath: path, x: 10, y: 20, width: 200 }, tab.execute, { retryDelay: 1 });
  assert.deepEqual(out, { shapeId: "shape-1", width: 40, height: 30 });
  assert.equal(tab.uploads.length, 1);
  assert.ok(tab.uploads[0].bytes.equals(data));
  assert.equal(tab.uploads[0].name, 'shot "one".png');
  assert.equal(tab.uploads[0].mime, "image/png");
  const r = tab.shapes[0];
  assert.deepEqual([r.x, r.y, r.w, r.h], [10, 20, 200, 150]);
  const pieces = Math.ceil(Buffer.from(data).toString("base64").length / PIECE);
  assert.equal(tab.calls, pieces + 1 + 1); // the pieces, one retry, the assembly
  assert.deepEqual(Object.keys(tab.storage), []);
});

test("without width or height the picture keeps its own size; height alone keeps proportions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penpot-"));
  const path = await picture(dir, "a.png", png(2000));
  const tab = fakeTab();
  await importImage({ filePath: path }, tab.execute);
  await importImage({ filePath: path, height: 60 }, tab.execute);
  assert.deepEqual([tab.shapes[0].w, tab.shapes[0].h], [40, 30]);
  assert.deepEqual([tab.shapes[1].w, tab.shapes[1].h], [80, 60]);
  assert.equal(tab.shapes[0].x, undefined);
});

test("a piece missing at assembly is caught, and the pieces are cleared", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penpot-"));
  const path = await picture(dir, "a.png", png(300 << 10));
  const tab = fakeTab({ drop: 1 });
  await assert.rejects(importImage({ filePath: path }, tab.execute), /piece 2 of \d+ did not arrive/);
  assert.equal(tab.uploads.length, 0);
  assert.deepEqual(Object.keys(tab.storage), []);
});

test("a piece refused twice stops the import and clears what was stored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penpot-"));
  const path = await picture(dir, "a.png", png(400 << 10));
  const tab = fakeTab({ fail: { 3: 2 } });
  await assert.rejects(importImage({ filePath: path }, tab.execute, { retryDelay: 1 }), /piece 4 of \d+: Tool execution failed/);
  assert.equal(tab.uploads.length, 0);
  assert.deepEqual(Object.keys(tab.storage), []);
});

test("wrong arguments and wrong files are refused before anything reaches Penpot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penpot-"));
  const text = await picture(dir, "notes.txt", Buffer.from("not a picture at all"));
  const empty = await picture(dir, "empty.png", Buffer.alloc(0));
  const huge = await picture(dir, "huge.png", Buffer.alloc((10 << 20) + 1));
  const good = await picture(dir, "good.png", png(64));
  const tab = fakeTab();
  for (const [args, says] of [
    [{ filePath: "relative/a.png" }, "absolute path"],
    [{ filePath: dir }, "is not a file"],
    [{ filePath: join(dir, "missing.png") }, "could not be read"],
    [{ filePath: empty }, "is empty"],
    [{ filePath: huge }, "up to 10 MB"],
    [{ filePath: text }, "not a PNG, JPEG, GIF or WEBP"],
    [{ filePath: good, width: -1 }, "positive numbers"],
    [{ filePath: good, height: 0 }, "positive numbers"],
    [{ filePath: good, x: "left" }, "plain numbers"],
  ]) {
    await assert.rejects(importImage(args, tab.execute), (err) => err instanceof ArgError && err.message.includes(says), JSON.stringify(args));
  }
  assert.equal(tab.calls, 0);
});

test("a FIFO named as the picture answers at once", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "penpot-"));
  const fifo = join(dir, "pipe.png");
  execFileSync("mkfifo", [fifo]);
  const started = Date.now();
  await assert.rejects(importImage({ filePath: fifo }, fakeTab().execute), /is not a file/);
  assert.ok(Date.now() - started < 2000);
});

test("sniff knows the four formats by their first bytes", () => {
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniff(Buffer.from("<svg>")), "");
});

test("the executor reads Penpot's answers and refusals", async () => {
  const run = executor({}, async (_u, method, params) => {
    assert.equal(method, "tools/call");
    assert.equal(params.name, "execute_code");
    if (params.arguments.code === "bad") return { content: [{ type: "text", text: "Tool execution failed: Error: suspended" }] };
    return { content: [{ type: "text", text: '{"result": 7, "log": ""}' }] };
  });
  assert.equal(await run("ok"), 7);
  await assert.rejects(run("bad"), /suspended/);
});

test("answer: an unknown tool, a wrong argument and a stopped import read as tool errors", async () => {
  assert.equal((await answer({ tool: "nope" })).isError, true);
  const arg = await answer({ tool: "import_image", arguments: { filePath: "x" } });
  assert.equal(arg.isError, true);
  assert.doesNotMatch(arg.content[0].text, /MCP connected/);
  const stopped = await answer({ tool: "import_image", arguments: {}, upstream: {} }, async () => { throw new Error("piece 1 of 2: suspended"); });
  assert.match(stopped.content[0].text, /^The picture did not reach Penpot: piece 1 of 2: suspended\. Check that the Penpot tab is open/);
  const ok = await answer({ tool: "import_image", arguments: {}, upstream: {} }, async () => ({ shapeId: "s", width: 1, height: 2 }));
  assert.deepEqual(JSON.parse(ok.content[0].text), { shapeId: "s", width: 1, height: 2 });
});

test("an import stops at its deadline and clears what it stored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penpot-"));
  const path = await picture(dir, "a.png", png(600 << 10));
  const tab = fakeTab();
  const slow = async (code) => { await new Promise((r) => setTimeout(r, 30)); return tab.execute(code); };
  await assert.rejects(importImage({ filePath: path }, slow, { until: Date.now() + 40 }), /the time for this call ran out/);
  assert.equal(tab.uploads.length, 0);
  assert.deepEqual(Object.keys(tab.storage), []);
});

test("at most two imports run at once; a third waits for a slot", async () => {
  let running = 0, most = 0;
  const run = async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 50)); running--; return { shapeId: "s", width: 1, height: 1 }; };
  const call = { tool: "import_image", arguments: {}, upstream: {}, deadline: new Date(Date.now() + 60_000).toISOString() };
  const out = await Promise.all([answer(call, run), answer(call, run), answer(call, run)]);
  assert.equal(most, 2);
  assert.ok(out.every((o) => !o.isError));
});
