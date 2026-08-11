import { TEAM_STYLE } from './config.js';

const INK = '#2a1d19';
const imageCache = new Map();

function cachedImage(source) {
  if (typeof Image === 'undefined') return null;
  if (!imageCache.has(source)) {
    const image = new Image();
    image.src = source;
    imageCache.set(source, image);
  }
  return imageCache.get(source);
}

export function drawFurniture(ctx, body, held) {
  const meta = body.plugin?.stackMeta;
  if (!meta?.shape) return;
  const { shape } = meta;
  const team = TEAM_STYLE[meta.team];
  const image = cachedImage(shape.imageSrc);
  const offset = meta.renderOffset ?? { x: 0, y: 0 };

  ctx.save();
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);
  ctx.imageSmoothingEnabled = true;
  ctx.shadowBlur = held ? 34 : 10;
  ctx.shadowColor = held ? team.glow : 'rgba(42, 29, 25, 0.28)';

  if (image?.complete && image.naturalWidth > 0) {
    ctx.drawImage(
      image,
      offset.x - shape.width / 2,
      offset.y - shape.height / 2,
      shape.width,
      shape.height,
    );
  } else {
    roundedRect(
      ctx,
      offset.x - shape.width / 2,
      offset.y - shape.height / 2,
      shape.width,
      shape.height,
      12,
    );
    ctx.fillStyle = team.main;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

export function drawFurniturePreview(ctx, shape, centerX, centerY, cellSize) {
  if (!shape?.imageSrc) return;
  const image = cachedImage(shape.imageSrc);
  if (!image?.complete || image.naturalWidth <= 0) return;
  const scale = Math.min(
    cellSize * 5.2 / shape.width,
    cellSize * 3.8 / shape.height,
  );
  const width = shape.width * scale;
  const height = shape.height * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, centerX - width / 2, centerY - height / 2, width, height);
  ctx.restore();
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
