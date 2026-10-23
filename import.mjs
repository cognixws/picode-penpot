// import_image: a picture on this computer into the open Penpot file. Penpot's
// hosted MCP has no import of its own and refuses a request above about
// 100 KB, so the picture travels in pieces through Penpot's execute_code,
// kept in the plugin's storage, then assembled, uploaded and set as one
// rectangle's fill. `execute` runs code in the Penpot tab through
// COGNIX[WS] (which holds the server's key) and answers what it returned.
import { open, constants } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_BYTES = 10 << 20;
// Base64 per execute_code: the hosted server answered 413 between 100 and
// 110 KB per request (2026-10-23).
export const PIECE = 72 << 10;
// Pieces at once: 38 pieces took 21.6 s one by one and 2.9 s eight at a
// time (2026-10-23); the tab keeps each by its index.
export const PARALLEL = 6;

export class ToolError extends Error {}
// ArgError is a wrong argument or file: nothing reached Penpot.
export class ArgError extends ToolError {}

// sniff names a picture from its first bytes, as a browser does.
export function sniff(buf) {
  const at = (i, bytes) => bytes.every((b, j) => buf[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buf.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/)) return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}

const finite = (n) => typeof n === "number" && Number.isFinite(n);

// readPicture checks the arguments and reads the file. It opens without
// waiting (a FIFO named here answers at once) and looks at what it opened.
export async function readPicture(args) {
  const a = args && typeof args === "object" ? args : {};
  for (const k of ["x", "y"]) if (a[k] !== undefined && !finite(a[k])) throw new ArgError("x and y are plain numbers");
  for (const k of ["width", "height"]) if (a[k] !== undefined && !(finite(a[k]) && a[k] > 0)) throw new ArgError("width and height are positive numbers");
  if (typeof a.filePath !== "string" || !isAbsolute(a.filePath)) throw new ArgError("filePath must be an absolute path on this computer");
  let fh;
  try {
    fh = await open(a.filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new ArgError(`${a.filePath} could not be read: ${err.code || err.message}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ArgError(`${a.filePath} is not a file`);
    if (st.size === 0) throw new ArgError(`${a.filePath} is empty`);
    if (st.size > MAX_BYTES) throw new ArgError(`${a.filePath} is ${(st.size / (1 << 20)).toFixed(1)} MB; import_image takes up to ${MAX_BYTES >> 20} MB`);
    const data = await fh.readFile();
    if (data.length === 0 || data.length > MAX_BYTES) throw new ArgError(`${a.filePath} could not be read`);
    const mime = sniff(data);
    if (!mime) throw new ArgError(`${a.filePath} is not a PNG, JPEG, GIF or WEBP picture`);
    return { args: a, data, mime, name: basename(a.filePath) };
  } finally {
    await fh.close();
  }
}

const num = (n) => (n === undefined ? "null" : String(n));

// assembly is the code that joins the pieces, checks every index and the
// byte count (a sparse array's some() skips its holes), uploads the picture
// and fills one rectangle with it.
export function assembly(key, pieces, bytes, pic) {
  const k = JSON.stringify(key);
  const name = JSON.stringify(pic.name);
  const a = pic.args;
  return `const parts = storage[${k}] || []; delete storage[${k}];
for (let i = 0; i < ${pieces}; i++) if (typeof parts[i] !== "string") throw new Error("piece " + (i + 1) + " of ${pieces} did not arrive");
const bin = atob(parts.slice(0, ${pieces}).join(""));
if (bin.length !== ${bytes}) throw new Error("the picture arrived with " + bin.length + " bytes instead of ${bytes}");
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
const img = await penpot.uploadMediaData(${name}, bytes, ${JSON.stringify(pic.mime)});
let w = ${num(a.width)}, h = ${num(a.height)};
if (w === null && h === null) { w = img.width; h = img.height; }
else if (w === null) { w = h * img.width / img.height; }
else if (h === null) { h = w * img.height / img.width; }
const r = penpot.createRectangle(); r.name = ${name}; r.resize(w, h);
const x = ${num(a.x)}, y = ${num(a.y)}; if (x !== null) r.x = x; if (y !== null) r.y = y;
r.fills = [{ fillOpacity: 1, fillImage: img }];
return { shapeId: r.id, width: img.width, height: img.height };`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// importImage sends the picture and answers the rectangle Penpot made.
export async function importImage(args, execute, { retryDelay = 1000 } = {}) {
  const pic = await readPicture(args);
  const key = "cognixImport" + randomBytes(8).toString("hex");
  const k = JSON.stringify(key);
  const encoded = pic.data.toString("base64");
  const pieces = [];
  for (let i = 0; i < encoded.length; i += PIECE) pieces.push(encoded.slice(i, i + PIECE));
  let failure = null;
  let next = 0;
  const worker = async () => {
    while (!failure && next < pieces.length) {
      const i = next++;
      const code = `(storage[${k}] ||= [])[${i}] = "${pieces[i]}"; return ${i};`;
      for (let attempt = 0; ; attempt++) {
        try {
          await execute(code);
          break;
        } catch (err) {
          if (failure) return;
          if (attempt === 0) {
            // A tab the browser put to sleep wakes in about a second.
            await sleep(retryDelay);
            continue;
          }
          failure = new ToolError(`piece ${i + 1} of ${pieces.length}: ${err.message}`);
          return;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, pieces.length) }, worker));
  const clear = () => execute(`delete storage[${k}]; return true;`).catch(() => {});
  if (failure) {
    await clear();
    throw failure;
  }
  try {
    return await execute(assembly(key, pieces.length, pic.data.length, pic));
  } catch (err) {
    await clear();
    throw new ToolError(err.message);
  }
}
