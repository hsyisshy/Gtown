/**
 * Shared image-preload helpers.
 *
 * Every game's sprites are module-level singletons (the same Image objects
 * get reused across every match in a session, `img.src` is set once at
 * import time), so waiting on them only matters the FIRST time a given game
 * is actually played — later matches resolve instantly since the images
 * are already downloaded and decoded.
 *
 * `img.decode()` (not `.complete`) is the actual fix here: `.complete` can
 * flip true before the browser has finished the decode work needed to
 * paint the frame, which is exactly the "fast input outruns the asset"
 * symptom this exists to close. A broken/404 image resolves instead of
 * rejecting so one bad asset can't hang an entire match.
 */
export function preloadImages(images) {
  return Promise.all(images.map(img => img.decode().catch(() => {})));
}

// Same idea, for plain path strings instead of already-constructed <img>
// elements — e.g. cover art / tutorial comic pages, which are DOM <img>s
// owned by screen/main.js and controller/main.js, not module-level Image
// singletons like the per-game canvas sprites above.
export function preloadImageUrls(paths) {
  return Promise.all((paths ?? []).map(src => {
    const img = new Image();
    img.src = src;
    return img.decode().catch(() => {});
  }));
}

// Screen-side "still loading" placeholder, shown in a game's draw() for the
// handful of frames (first match of a session only) between onStart() and
// its preload() resolving. Kept intentionally plain — this is a rare,
// short-lived state, not a designed screen.
export function drawAssetLoadingPlaceholder(ctx, w, h, label) {
  ctx.fillStyle = '#14141a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#eee';
  ctx.font = 'bold 28px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${label}　載入中…`, w / 2, h / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
