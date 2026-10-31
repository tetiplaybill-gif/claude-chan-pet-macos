import test from 'node:test';
import assert from 'node:assert/strict';
import { createClickGesture, visibleMediaAnchor } from '../src/shared/pet-interaction.js';

const point = (screenX, screenY, extras = {}) => ({ button: 0, buttons: 1, screenX, screenY, ...extras });

test('many tiny movements are still one click, including exactly 5 DIP', () => {
  const gesture = createClickGesture();
  assert(gesture.begin(point(100, 200)));
  for (const [dx, dy] of [[0, 0], [1, 1], [-2, 2], [3, 4]]) assert(gesture.move(point(100 + dx, 200 + dy)));
  assert(gesture.finish(point(103, 204, { buttons: 0 })));
  assert.equal(gesture.finish(point(103, 204, { buttons: 0 })), false);
});

test('drag beyond threshold then return to origin never clicks', () => {
  const gesture = createClickGesture();
  gesture.begin(point(100, 200));
  gesture.move(point(106, 200));
  gesture.move(point(100, 200));
  assert.equal(gesture.finish(point(100, 200)), false);
});

test('screen-space displacement wins when moving window keeps client coordinates fixed', () => {
  const gesture = createClickGesture();
  gesture.begin(point(100, 200, { clientX: 20, clientY: 30 }));
  gesture.move(point(150, 230, { clientX: 20, clientY: 30 }));
  assert.equal(gesture.finish(point(150, 230, { clientX: 20, clientY: 30 })), false);
});

test('window motion alone does not invent a drag from changing client coordinates', () => {
  const gesture = createClickGesture();
  gesture.begin(point(100, 200, { clientX: 20, clientY: 30 }));
  gesture.move(point(100, 200, { clientX: 70, clientY: 80 }));
  assert(gesture.finish(point(100, 200, { clientX: 70, clientY: 80 })));
});

test('release position detects missed or coalesced mousemove', () => {
  const gesture = createClickGesture();
  gesture.begin(point(100, 200));
  assert.equal(gesture.finish(point(106, 200)), false);
});

test('lost mouseup followed by buttons=0 cannot toggle later', () => {
  const gesture = createClickGesture();
  gesture.begin(point(100, 200));
  assert.equal(gesture.move(point(100, 200, { buttons: 0 })), false);
  assert.equal(gesture.finish(point(100, 200)), false);
});

test('blur or pointer cancellation invalidates click, next press works', () => {
  const gesture = createClickGesture();
  gesture.begin(point(100, 200));
  gesture.cancel();
  assert.equal(gesture.finish(point(100, 200)), false);
  gesture.begin(point(100, 200));
  assert(gesture.finish(point(100, 200)));
});

test('right button, unmatched release and invalid coordinates never click', () => {
  const gesture = createClickGesture();
  assert.equal(gesture.begin(point(10, 20, { button: 2, buttons: 2 })), false);
  assert.equal(gesture.finish(point(10, 20, { button: 2 })), false);
  assert.equal(gesture.finish(point(10, 20)), false);
  gesture.begin(point(10, 20));
  assert.equal(gesture.finish(point(NaN, 20)), false);
});

test('diagonal distance uses a radial 5 DIP threshold', () => {
  const gesture = createClickGesture();
  gesture.begin(point(0, 0));
  gesture.move(point(4, 4));
  assert.equal(gesture.finish(point(4, 4)), false);
});

test('anchor excludes transparent window padding and bottom-aligns intrinsic media', () => {
  assert.deepEqual(visibleMediaAnchor(400, 350, 200, 233, 392, 457),
    { x: 100.1, y: 117, width: 199.9, height: 233 });
  assert.deepEqual(visibleMediaAnchor(400, 350, 388, 233, 811, 560),
    { x: 31.3, y: 117, width: 337.4, height: 233 });
});

test('anchor handles wide clips without stretching and rejects unloaded media', () => {
  assert.deepEqual(visibleMediaAnchor(300, 350, 288, 233, 811, 560),
    { x: 6, y: 151.1, width: 288, height: 198.9 });
  assert.equal(visibleMediaAnchor(400, 350, 200, 233, 0, 0), null);
});
