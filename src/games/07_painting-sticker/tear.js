/**
 * Voronoi + torn-edge piece generator — ported from painting_sticker/tear.js.
 * Splits a painting into irregular jigsaw-ish pieces at runtime instead of
 * shipping pre-cut PNGs: seed points on a jittered grid -> Voronoi cells ->
 * midpoint-displaced ("torn paper") edges -> rasterized + slightly dilated
 * alpha masks so adjacent pieces overlap a little and hide seams.
 */
import { Delaunay } from 'd3-delaunay';

export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Finds cols x rows factors of `count` closest to square, so an arbitrary
// piece-count constant can drive the seed grid.
export function computeGridForCount(count) {
  let best = { cols: count, rows: 1 };
  for (let cols = 1; cols <= count; cols++) {
    if (count % cols !== 0) continue;
    const rows = count / cols;
    if (Math.abs(cols - rows) < Math.abs(best.cols - best.rows)) {
      best = { cols, rows };
    }
  }
  return best;
}

function makeSeedPoints(w, h, cols, rows, jitter, rand) {
  const pts = [];
  const cellW = w / cols;
  const cellH = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cellW;
      const cy = (r + 0.5) * cellH;
      const dx = (rand() - 0.5) * 2 * jitter * cellW;
      const dy = (rand() - 0.5) * 2 * jitter * cellH;
      pts.push([cx + dx, cy + dy]);
    }
  }
  return pts;
}

function voronoiCellPolygons(points, w, h) {
  const delaunay = Delaunay.from(points);
  const voronoi = delaunay.voronoi([0, 0, w, h]);
  const polys = [];
  for (let i = 0; i < points.length; i++) {
    const poly = voronoi.cellPolygon(i);
    if (poly && poly.length >= 3) polys.push(poly);
  }
  return polys;
}

// Exported so index.js can reuse the same midpoint-displacement recipe for
// the "torn paper" panel edges (not just piece cuts).
export function tearEdge(p1, p2, depth, iters, decay, rand) {
  let pts = [p1, p2];
  for (let k = 0; k < iters; k++) {
    const next = [pts[0]];
    for (let j = 0; j < pts.length - 1; j++) {
      const a = pts[j];
      const b = pts[j + 1];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const segx = b[0] - a[0];
      const segy = b[1] - a[1];
      const length = Math.hypot(segx, segy);
      if (length < 1e-6) {
        next.push(b);
        continue;
      }
      const nx = -segy / length;
      const ny = segx / length;
      const offset = (rand() - 0.5) * 2 * depth;
      next.push([mid[0] + nx * offset, mid[1] + ny * offset]);
      next.push(b);
    }
    pts = next;
    depth *= decay;
  }
  return pts;
}

function tornPolygon(ring, depth, iters, decay, rand) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const coords = first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring.slice();
  const tornPts = [];
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    const segPts = tearEdge(a, b, depth, iters, decay, rand);
    for (let k = 0; k < segPts.length - 1; k++) tornPts.push(segPts[k]);
  }
  return tornPts;
}

function polygonBounds(pts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}

function rasterizeMask(pts, canvasW, canvasH, offsetX, offsetY, supersample) {
  const big = document.createElement('canvas');
  big.width = canvasW * supersample;
  big.height = canvasH * supersample;
  const bctx = big.getContext('2d');
  bctx.fillStyle = '#fff';
  bctx.beginPath();
  pts.forEach(([x, y], idx) => {
    const px = (x - offsetX) * supersample;
    const py = (y - offsetY) * supersample;
    if (idx === 0) bctx.moveTo(px, py);
    else bctx.lineTo(px, py);
  });
  bctx.closePath();
  bctx.fill();

  const small = document.createElement('canvas');
  small.width = canvasW;
  small.height = canvasH;
  small.getContext('2d').drawImage(big, 0, 0, canvasW, canvasH);
  return small;
}

function dilateMask(maskCanvas, radiusPx) {
  if (radiusPx <= 0) return maskCanvas;
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const blurred = document.createElement('canvas');
  blurred.width = w;
  blurred.height = h;
  const bctx = blurred.getContext('2d');
  bctx.filter = `blur(${radiusPx}px)`;
  bctx.drawImage(maskCanvas, 0, 0);
  bctx.filter = 'none';
  const imgData = bctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const grown = d[i + 3] > 8 ? 255 : 0;
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
    d[i + 3] = grown;
  }
  bctx.putImageData(imgData, 0, 0);
  return blurred;
}

function compositePiece(rawImage, srcW, srcH, canvasW, canvasH, offsetX, offsetY, mask) {
  const out = document.createElement('canvas');
  out.width = canvasW;
  out.height = canvasH;
  const octx = out.getContext('2d');

  const sx0 = Math.floor(offsetX);
  const sy0 = Math.floor(offsetY);
  const clampedSx0 = Math.max(sx0, 0);
  const clampedSy0 = Math.max(sy0, 0);
  const clampedSx1 = Math.min(sx0 + canvasW, srcW);
  const clampedSy1 = Math.min(sy0 + canvasH, srcH);
  const cw = clampedSx1 - clampedSx0;
  const ch = clampedSy1 - clampedSy0;
  if (cw > 0 && ch > 0) {
    const destX = clampedSx0 - sx0;
    const destY = clampedSy0 - sy0;
    octx.drawImage(rawImage, clampedSx0, clampedSy0, cw, ch, destX, destY, cw, ch);
  }

  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(mask, 0, 0);
  octx.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Reads an already-loaded painting Image + tear config, returns generated
 * pieces. Deterministic for a given (image, config, seed) triple.
 */
export function generatePieces(rawImage, config, seed) {
  const effectiveSeed = typeof seed === 'number' ? seed : config.randomSeed;
  const rand = typeof effectiveSeed === 'number' ? mulberry32(effectiveSeed) : Math.random;
  const W = rawImage.naturalWidth;
  const H = rawImage.naturalHeight;

  const points = makeSeedPoints(W, H, config.cols, config.rows, config.seedJitter, rand);
  const cellPolys = voronoiCellPolygons(points, W, H);
  const tornRings = cellPolys.map((poly) =>
    tornPolygon(poly, config.tearDepthPx, config.tearIterations, config.tearDepthDecay, rand)
  );

  let maxW = 0, maxH = 0;
  const boundsList = tornRings.map((pts) => {
    const b = polygonBounds(pts);
    maxW = Math.max(maxW, b[2] - b[0]);
    maxH = Math.max(maxH, b[3] - b[1]);
    return b;
  });

  const canvasW = Math.ceil(maxW) + config.canvasPaddingPx * 2 + config.overlapPx * 2;
  const canvasH = Math.ceil(maxH) + config.canvasPaddingPx * 2 + config.overlapPx * 2;

  const pieceCanvases = {};
  const pieces = [];
  for (let i = 0; i < tornRings.length; i++) {
    const pts = tornRings[i];
    const [minx, miny, maxx, maxy] = boundsList[i];
    const cx = (minx + maxx) / 2;
    const cy = (miny + maxy) / 2;
    const originX = cx - canvasW / 2;
    const originY = cy - canvasH / 2;

    let mask = rasterizeMask(pts, canvasW, canvasH, originX, originY, config.supersample);
    mask = dilateMask(mask, config.overlapPx);
    const pieceCanvas = compositePiece(rawImage, W, H, canvasW, canvasH, originX, originY, mask);

    const id = i + 1;
    pieceCanvases[id] = pieceCanvas;
    pieces.push({ id, canvas_origin_in_source: [originX, originY] });
  }

  return { pieceCanvases, pieces, canvasW, canvasH, sourceW: W, sourceH: H };
}
