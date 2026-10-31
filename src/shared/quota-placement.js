/**
 * Pure placement of a quota popup beside its pet window.
 *
 * All input and output rectangles use Electron DIP coordinates. scaleFactor is
 * intentionally unused: multiplying it would break mixed-Retina arrangements.
 * Pass the last returned side as preferredSide while moving the pet to retain
 * a usable attachment side instead of flipping back at the first spare pixel.
 */

const GAP = 12;
const SIDES = ['right', 'left', 'top', 'bottom'];

function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) &&
    rect.width > 0 && rect.height > 0 &&
    Number.isFinite(rect.x + rect.width) && Number.isFinite(rect.y + rect.height) &&
    Number.isFinite(rect.width * rect.height);
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function area(rect) {
  return rect.width * rect.height;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function stableDisplayOrder(a, b) {
  if (typeof a.id === 'number' && typeof b.id === 'number' && a.id !== b.id) return a.id - b.id;
  const idA = String(a.id);
  const idB = String(b.id);
  if (idA !== idB) return idA < idB ? -1 : 1;
  return a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y ||
    a.bounds.width - b.bounds.width || a.bounds.height - b.bounds.height;
}

function usableDisplays(displays) {
  return displays.flatMap((display) => {
    if (!display || !validRect(display.bounds) || !validRect(display.workArea)) return [];
    const visibleWorkArea = intersection(display.bounds, display.workArea);
    // BrowserWindow bounds must be integral. Round the work area inward so a
    // fractional display edge cannot put even one DIP into the Dock or beyond
    // the display when the final window rectangle is rounded.
    const x = Math.ceil(visibleWorkArea.x);
    const y = Math.ceil(visibleWorkArea.y);
    const width = Math.floor(visibleWorkArea.x + visibleWorkArea.width) - x;
    const height = Math.floor(visibleWorkArea.y + visibleWorkArea.height) - y;
    if (width < 1 || height < 1) return [];
    return [{ id: display.id, bounds: display.bounds, workArea: { x, y, width, height } }];
  });
}

function chooseDisplay(pet, displays) {
  const center = { x: pet.x + pet.width / 2, y: pet.y + pet.height / 2 };
  const scored = displays.map((display) => ({
    ...display,
    visibleArea: area(intersection(pet, display.bounds)),
  }));
  const largestArea = Math.max(...scored.map((display) => display.visibleArea));
  if (largestArea > 0) {
    // Treat approximately one DIP of movement across a seam as a tie. This
    // prevents tiny fractional coordinates or display enumeration order from
    // switching monitors back and forth when the pet straddles their boundary.
    const tieArea = Math.max(pet.width, pet.height) * 2;
    const candidates = scored.filter((display) => display.visibleArea > 0 &&
      largestArea - display.visibleArea <= tieArea);
    const centered = candidates.filter(({ bounds }) =>
      center.x > bounds.x + 2 && center.x < bounds.x + bounds.width - 2 &&
      center.y > bounds.y + 2 && center.y < bounds.y + bounds.height - 2);
    return (centered.length ? centered : candidates).sort(stableDisplayOrder)[0];
  }
  // A display can disappear during a drag. Keep the popup on the nearest
  // remaining display even if the last pet rectangle is entirely offscreen.
  const distance = ({ bounds }) => {
    const dx = center.x - clamp(center.x, bounds.x, bounds.x + bounds.width);
    const dy = center.y - clamp(center.y, bounds.y, bounds.y + bounds.height);
    return dx * dx + dy * dy;
  };
  return scored.sort((a, b) => distance(a) - distance(b) || stableDisplayOrder(a, b))[0];
}

/**
 * @param {{x:number,y:number,width:number,height:number}} petBounds
 * @param {{width:number,height:number}} popupSize Desired unscaled DIP size.
 * @param {Array<{id:number|string,bounds:object,workArea:object,scaleFactor:number}>} displays
 * @param {'right'|'left'|'top'|'bottom'|'clamped'} preferredSide Last side, or 'right' initially.
 * @returns {{x:number,y:number,width:number,height:number,side:string,displayId:number|string}}
 * side='clamped' means no non-overlapping side fits. The popup still stays
 * completely inside the chosen work area, possibly reduced to fit a small
 * display. No inputs are mutated and no application or screen APIs are used.
 * @throws {RangeError} For invalid pet/size or no usable display work area.
 */
export function placeQuotaPopup(petBounds, popupSize, displays, preferredSide = 'right') {
  if (!validRect(petBounds)) throw new RangeError('petBounds must be a finite rectangle with positive size');
  if (!popupSize || !Number.isFinite(popupSize.width) || !Number.isFinite(popupSize.height) ||
      popupSize.width <= 0 || popupSize.height <= 0) {
    throw new RangeError('popupSize must have finite positive width and height');
  }
  const available = Array.isArray(displays) ? usableDisplays(displays) : [];
  if (!available.length) throw new RangeError('At least one display with a usable workArea is required');

  const display = chooseDisplay(petBounds, available);
  const work = display.workArea;
  const width = Math.min(Math.ceil(popupSize.width), work.width);
  const height = Math.min(Math.ceil(popupSize.height), work.height);
  const petRight = petBounds.x + petBounds.width;
  const petBottom = petBounds.y + petBounds.height;
  const middleX = petBounds.x + (petBounds.width - width) / 2;
  const middleY = petBounds.y + (petBounds.height - height) / 2;
  const candidates = {
    right: { x: Math.ceil(petRight + GAP), y: Math.round(middleY) },
    left: { x: Math.floor(petBounds.x - GAP - width), y: Math.round(middleY) },
    top: { x: Math.round(middleX), y: Math.floor(petBounds.y - GAP - height) },
    bottom: { x: Math.round(middleX), y: Math.ceil(petBottom + GAP) },
  };
  const preferred = SIDES.includes(preferredSide) ? preferredSide : 'right';
  const order = [preferred, ...SIDES.filter((side) => side !== preferred)];
  const limit = ({ x, y }) => ({
    x: clamp(x, work.x, work.x + work.width - width),
    y: clamp(y, work.y, work.y + work.height - height),
  });
  const result = (position, side) => ({ ...position, width, height, side, displayId: display.id });

  for (const side of order) {
    const position = candidates[side];
    const fits = side === 'right' || side === 'left'
      ? position.x >= work.x && position.x + width <= work.x + work.width
      : position.y >= work.y && position.y + height <= work.y + work.height;
    if (fits) return result(limit(position), side);
  }

  // No non-overlapping placement exists at this size. Use one continuous
  // clamped anchor rather than re-ranking overlapping candidates: the latter
  // can jump from top to bottom as the pet moves by a single DIP near center.
  // Keep this fallback independent of preferredSide because 'clamped' carries
  // no previous attachment-side state.
  return result(limit(candidates.right), 'clamped');
}
