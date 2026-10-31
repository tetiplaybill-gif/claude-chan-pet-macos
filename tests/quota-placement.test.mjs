import test from 'node:test';
import assert from 'node:assert/strict';
import { placeQuotaPopup } from '../src/shared/quota-placement.js';

const display = (id, bounds, workArea = bounds, scaleFactor = 1) => ({ id, bounds, workArea, scaleFactor });
const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 0, y: 24, width: 1920, height: 1000 }, 2);
const size = { width: 320, height: 220 };
const within = (popup, screen) => {
  const work = screen.workArea;
  for (const key of ['x', 'y', 'width', 'height']) assert(Number.isInteger(popup[key]), `${key} must be integral DIP`);
  assert(popup.width > 0 && popup.height > 0);
  assert(popup.x >= work.x, `${popup.x} < work left ${work.x}`);
  assert(popup.y >= work.y, `${popup.y} < work top ${work.y}`);
  assert(popup.x + popup.width <= work.x + work.width);
  assert(popup.y + popup.height <= work.y + work.height);
};

test('defaults to the right and tracks pet movement in DIP', () => {
  const pet = { x: 700, y: 500, width: 200, height: 300 };
  const popup = placeQuotaPopup(pet, size, [primary]);
  assert.equal(popup.side, 'right');
  assert.equal(popup.x, pet.x + pet.width + 12);
  assert.equal(popup.y + popup.height / 2, pet.y + pet.height / 2);
  assert.equal(popup.displayId, primary.id);
  const moved = placeQuotaPopup({ ...pet, x: pet.x + 30, y: pet.y - 20 }, size, [primary], popup.side);
  assert.equal(moved.x - popup.x, 30);
  assert.equal(moved.y - popup.y, -20);
  within(popup, primary);
});

test('right edge changes to the left with a gap and no pet overlap', () => {
  const pet = { x: 1700, y: 700, width: 200, height: 300 };
  const popup = placeQuotaPopup(pet, size, [primary]);
  assert.equal(popup.side, 'left');
  assert.equal(popup.x + popup.width, pet.x - 12);
  within(popup, primary);
});

test('left edge stays on the right', () => {
  const popup = placeQuotaPopup({ x: -20, y: 200, width: 200, height: 300 }, size, [primary]);
  assert.equal(popup.side, 'right');
  within(popup, primary);
});

for (const [edge, workArea, pet] of [
  ['bottom', { x: 0, y: 24, width: 1000, height: 716 }, { x: 600, y: 690, width: 140, height: 200 }],
  ['top', { x: 0, y: 70, width: 1000, height: 730 }, { x: 400, y: -10, width: 140, height: 200 }],
  ['left', { x: 80, y: 24, width: 920, height: 776 }, { x: 0, y: 400, width: 140, height: 200 }],
  ['right', { x: 0, y: 24, width: 920, height: 776 }, { x: 850, y: 400, width: 140, height: 200 }],
]) {
  test(`respects ${edge} Dock or reserved work-area space`, () => {
    const screen = display(1, { x: 0, y: 0, width: 1000, height: 800 }, workArea);
    const popup = placeQuotaPopup(pet, size, [screen]);
    within(popup, screen);
  });
}

test('uses above when neither horizontal side fits', () => {
  const screen = display(1, { x: 0, y: 0, width: 480, height: 900 });
  const pet = { x: 140, y: 600, width: 200, height: 200 };
  const popup = placeQuotaPopup(pet, { width: 400, height: 250 }, [screen]);
  assert.equal(popup.side, 'top');
  assert.equal(popup.y + popup.height, pet.y - 12);
  within(popup, screen);
});

test('uses below when horizontal sides and above do not fit', () => {
  const screen = display(1, { x: 0, y: 0, width: 480, height: 900 });
  const pet = { x: 140, y: 10, width: 200, height: 200 };
  const popup = placeQuotaPopup(pet, { width: 400, height: 250 }, [screen]);
  assert.equal(popup.side, 'bottom');
  assert.equal(popup.y, pet.y + pet.height + 12);
  within(popup, screen);
});

test('oversized popup shrinks to a tiny work area and remains visible', () => {
  const screen = display(1, { x: 0, y: 0, width: 320, height: 240 });
  const popup = placeQuotaPopup({ x: 40, y: 40, width: 200, height: 180 }, { width: 640, height: 480 }, [screen]);
  assert.deepEqual(popup, { x: 0, y: 0, width: 320, height: 240, side: 'clamped', displayId: 1 });
  within(popup, screen);
});

test('no-side-fit fallback remains within workArea without shrinking unnecessarily', () => {
  const screen = display(1, { x: 0, y: 0, width: 500, height: 400 });
  const popup = placeQuotaPopup({ x: 150, y: 100, width: 200, height: 200 }, { width: 340, height: 250 }, [screen]);
  assert.equal(popup.side, 'clamped');
  assert.equal(popup.width, 340);
  assert.equal(popup.height, 250);
  within(popup, screen);
});

test('clamped fallback does not jump between opposite edges on tiny movement', () => {
  const screen = display(1, { x: 0, y: 0, width: 500, height: 400 });
  let previous;
  for (const y of [99, 100, 101, 100, 99]) {
    const popup = placeQuotaPopup({ x: 150, y, width: 200, height: 200 },
      { width: 340, height: 250 }, [screen], previous?.side ?? 'left');
    assert.equal(popup.side, 'clamped');
    if (previous) {
      assert.equal(popup.x, previous.x);
      assert(Math.abs(popup.y - previous.y) <= 1);
    }
    within(popup, screen);
    previous = popup;
  }
});

test('negative-coordinate monitor uses its own Dock work area', () => {
  const left = display(2, { x: -1280, y: 0, width: 1280, height: 1024 },
    { x: -1280, y: 24, width: 1280, height: 940 });
  const popup = placeQuotaPopup({ x: -1000, y: 500, width: 200, height: 250 }, size, [primary, left]);
  assert.equal(popup.displayId, 2);
  assert(popup.x < 0);
  within(popup, left);
});

test('monitor above primary preserves negative y coordinates', () => {
  const upper = display(3, { x: 0, y: -900, width: 1600, height: 900 },
    { x: 0, y: -876, width: 1600, height: 876 });
  const popup = placeQuotaPopup({ x: 500, y: -700, width: 200, height: 250 }, size, [primary, upper]);
  assert.equal(popup.displayId, 3);
  assert(popup.y < 0);
  within(popup, upper);
});

test('mixed Retina scale factors never change DIP placement', () => {
  const screens = [
    display(1, { x: 0, y: 0, width: 1440, height: 900 }, undefined, 2),
    display(2, { x: 1440, y: 100, width: 1920, height: 1080 }, undefined, 1),
  ];
  const pet = { x: 1600, y: 500, width: 200, height: 250 };
  const a = placeQuotaPopup(pet, size, screens);
  const b = placeQuotaPopup(pet, size, screens.map((screen) => ({ ...screen, scaleFactor: 3.5 })));
  assert.deepEqual(a, b);
  assert.equal(a.width, size.width);
  assert.equal(a.x, pet.x + pet.width + 12);
  within(a, screens[1]);
});

const adjacent = [
  display(1, { x: 0, y: 0, width: 1000, height: 800 }),
  display(2, { x: 1000, y: 0, width: 1000, height: 800 }),
];

test('chooses largest visible pet area across a display seam', () => {
  const popup = placeQuotaPopup({ x: 950, y: 300, width: 300, height: 200 }, size, adjacent);
  assert.equal(popup.displayId, 2);
  within(popup, adjacent[1]);
});

test('equal seam overlap is independent of display enumeration order', () => {
  const pet = { x: 900, y: 300, width: 200, height: 200 };
  assert.deepEqual(placeQuotaPopup(pet, size, adjacent), placeQuotaPopup(pet, size, [...adjacent].reverse()));
});

test('fractional movement at a seam does not oscillate between monitors', () => {
  const ids = [899.7, 900.2, 899.8, 900.3, 900].map((x) =>
    placeQuotaPopup({ x, y: 300, width: 200, height: 200 }, size, adjacent).displayId);
  assert.equal(new Set(ids).size, 1);
  assert.equal(placeQuotaPopup({ x: 910, y: 300, width: 200, height: 200 }, size, adjacent).displayId, 2);
});

test('offscreen pet after display removal falls back to nearest screen', () => {
  const screens = [adjacent[0], display(2, { x: 1200, y: 0, width: 1000, height: 800 })];
  const popup = placeQuotaPopup({ x: 1150, y: 300, width: 20, height: 100 }, size, screens);
  assert.equal(popup.displayId, 2);
  within(popup, screens[1]);
});

test('passing previous side prevents edge flip-flop on a one-DIP drag', () => {
  const screen = display(1, { x: 0, y: 0, width: 1000, height: 800 });
  const sides = [];
  let side = 'right';
  for (const x of [687, 688, 689, 688, 687, 688, 689]) {
    const popup = placeQuotaPopup({ x, y: 300, width: 100, height: 200 }, { width: 200, height: 180 }, [screen], side);
    side = popup.side;
    sides.push(side);
    within(popup, screen);
  }
  assert.deepEqual(sides, ['right', 'right', 'left', 'left', 'left', 'left', 'left']);
});

test('movement on an available side is continuous and edge clamping is monotonic', () => {
  const screen = display(1, { x: 0, y: 0, width: 1200, height: 900 },
    { x: 0, y: 24, width: 1200, height: 852 });
  let previous;
  for (let y = 600; y <= 850; y++) {
    const popup = placeQuotaPopup({ x: 400, y, width: 150, height: 150 }, { width: 220, height: 200 }, [screen], previous?.side);
    assert.equal(popup.side, 'right');
    if (previous) {
      assert.equal(popup.x, previous.x);
      assert(popup.y - previous.y >= 0 && popup.y - previous.y <= 1);
    }
    within(popup, screen);
    previous = popup;
  }
});

test('fractional work-area bounds are rounded inward, including negative origins', () => {
  const screen = display(1, { x: -100.3, y: -20.6, width: 1000.2, height: 700.1 });
  const popup = placeQuotaPopup({ x: 750.5, y: 600.1, width: 120.2, height: 100.4 }, { width: 280.4, height: 230.1 }, [screen]);
  assert.equal(popup.width, 281);
  assert.equal(popup.height, 231);
  within(popup, screen);
});

test('does not mutate inputs', () => {
  const pet = Object.freeze({ x: 500, y: 300, width: 200, height: 250 });
  const popupSize = Object.freeze({ ...size });
  const screen = Object.freeze({ ...primary, bounds: Object.freeze({ ...primary.bounds }), workArea: Object.freeze({ ...primary.workArea }) });
  assert.doesNotThrow(() => placeQuotaPopup(pet, popupSize, Object.freeze([screen])));
});

test('rejects invalid geometry but skips unusable hot-plug display entries', () => {
  const pet = { x: 500, y: 300, width: 200, height: 250 };
  assert.throws(() => placeQuotaPopup({ ...pet, x: NaN }, size, [primary]), RangeError);
  assert.throws(() => placeQuotaPopup(pet, { width: 0, height: 200 }, [primary]), RangeError);
  assert.throws(() => placeQuotaPopup(pet, size, []), RangeError);
  const popup = placeQuotaPopup(pet, size, [null, { id: 9, bounds: primary.bounds, workArea: { x: 0, y: 0, width: 0, height: 0 } }, primary]);
  within(popup, primary);
});

test('seeded mixed-monitor placements always remain within chosen workArea', () => {
  const screens = [primary,
    display(2, { x: -1280, y: -300, width: 1280, height: 1024 }, { x: -1200, y: -276, width: 1200, height: 1000 }, 1),
    display(3, { x: 400, y: -1200, width: 1600, height: 1200 }, { x: 400, y: -1176, width: 1600, height: 1152 }, 1.5)];
  let seed = 30981;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 1000; i++) {
    const pet = { x: rand() * 4500 - 1600, y: rand() * 3000 - 1500, width: 50 + rand() * 600, height: 50 + rand() * 600 };
    const popupSize = { width: 100 + rand() * 2200, height: 100 + rand() * 1500 };
    const popup = placeQuotaPopup(pet, popupSize, screens, ['right', 'left', 'top', 'bottom'][i % 4]);
    const chosen = screens.find((screen) => screen.id === popup.displayId);
    within(popup, chosen);
    assert(popup.width <= Math.ceil(popupSize.width));
    assert(popup.height <= Math.ceil(popupSize.height));
  }
});
