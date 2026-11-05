// Turn a string into closed polygon contours (mm) using real font outlines (Liberation Sans, SIL OFL).
import opentype from "opentype.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts");
const cache = {};
function font(bold) {
  const f = bold ? "LiberationSans-Bold.ttf" : "LiberationSans-Regular.ttf";
  if (!cache[f]) {
    const b = fs.readFileSync(path.join(dir, f));
    cache[f] = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  return cache[f];
}

/**
 * @returns {{contours: number[][][], width:number, height:number}} contours in mm, y up,
 *   baseline at y, left edge (or centre) at x. `height` = cap height.
 */
export function textContours({ text, x = 0, y = 0, height = 10, bold = false, align = "left", steps = 8 }) {
  if (!text || !String(text).trim()) throw new Error("text is empty");
  if (!(height > 0)) throw new Error("text height must be > 0");
  const f = font(bold);
  const cap = (f.tables.os2?.sCapHeight || f.unitsPerEm * 0.72);
  const size = (height * f.unitsPerEm) / cap;
  const p = f.getPath(String(text), 0, 0, size);
  const bb = p.getBoundingBox();
  const width = bb.x2 - bb.x1;
  const dx = x - (align === "center" ? bb.x1 + width / 2 : bb.x1);

  const contours = [];
  let cur = null, last = null;
  const push = (px, py) => {
    const pt = [px + dx, y - py];            // opentype is y-down
    if (!cur) return;
    const q = cur[cur.length - 1];
    if (!q || Math.hypot(q[0] - pt[0], q[1] - pt[1]) > 1e-3) cur.push(pt);
    last = pt;
  };
  const finish = () => {
    if (cur && cur.length > 1 && Math.hypot(cur[0][0] - cur[cur.length - 1][0], cur[0][1] - cur[cur.length - 1][1]) < 1e-3) cur.pop();
    if (cur && cur.length >= 3) contours.push(cur);
    cur = null;
  };
  for (const c of p.commands) {
    if (c.type === "M") { finish(); cur = []; push(c.x, c.y); last = [c.x, c.y]; }
    else if (c.type === "L") push(c.x, c.y);
    else if (c.type === "Q" || c.type === "C") {
      const sx = cur[cur.length - 1][0] - dx, sy = y - cur[cur.length - 1][1];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        if (c.type === "Q") push(u * u * sx + 2 * u * t * c.x1 + t * t * c.x, u * u * sy + 2 * u * t * c.y1 + t * t * c.y);
        else push(u ** 3 * sx + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x, u ** 3 * sy + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y);
      }
    } else if (c.type === "Z") finish();
  }
  finish();
  return { contours, width, height };
}
