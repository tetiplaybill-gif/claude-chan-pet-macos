/** Screen coordinates stay stable when the native pet window follows the pointer. */
export function createClickGesture(threshold = 5) {
  let origin = null;
  let exceeded = false;
  const validPoint = (event) => Number.isFinite(event.screenX) && Number.isFinite(event.screenY);
  const cancel = () => { origin = null; exceeded = false; };
  const measure = (event) => {
    if (Math.hypot(event.screenX - origin.x, event.screenY - origin.y) > threshold) exceeded = true;
  };
  return {
    begin(event) {
      cancel();
      if (event.button !== 0 || !validPoint(event)) return false;
      origin = { x: event.screenX, y: event.screenY };
      return true;
    },
    move(event) {
      if (!origin) return false;
      if (!(event.buttons & 1) || !validPoint(event)) { cancel(); return false; }
      measure(event);
      return true;
    },
    finish(event) {
      if (!origin || event.button !== 0 || !validPoint(event)) { cancel(); return false; }
      measure(event); // A final mousemove may have been coalesced or never delivered.
      const clicked = !exceeded;
      cancel();
      return clicked;
    },
    cancel,
  };
}

/** Untransformed, bottom-centred object-fit:contain geometry; excludes breathing. */
export function visibleMediaAnchor(viewportWidth, viewportHeight, boxWidth, boxHeight, mediaWidth, mediaHeight) {
  if (![viewportWidth, viewportHeight, boxWidth, boxHeight, mediaWidth, mediaHeight]
    .every((value) => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(boxWidth / mediaWidth, boxHeight / mediaHeight);
  const width = Math.min(viewportWidth, mediaWidth * scale);
  const height = Math.min(viewportHeight, mediaHeight * scale);
  const round = (value) => Math.round(value * 10) / 10;
  return { x: round((viewportWidth - width) / 2), y: round(viewportHeight - height),
    width: round(width), height: round(height) };
}
