import assert from 'node:assert/strict';
import test from 'node:test';
import { GADGET_CONTRACT_VERSION } from './contracts';
import { coerceGadgetBlock, validateGadgetEnvelope } from './validation';
import { isImageArtifact, isImageOnlyArtifactGadget, promoteArtifactGadgetToImage } from './imageGadget';

const SCOPE = { hostId: 'host-1', projectId: 'project-1', sessionId: 'session-1', workId: 'FX-1' };

function envelope(kind: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    version: GADGET_CONTRACT_VERSION,
    gadgetId: `gadget-${kind}`,
    kind,
    scope: SCOPE,
    issuedAt: '2026-09-13T10:00:00.000Z',
    fallbackText: '',
    payload,
    actions: [],
    ...overrides
  };
}

test('a picture is recognised by its media type, or by its extension', () => {
  assert.equal(isImageArtifact({ path: 'shot.png', mediaType: 'image/png' }), true);
  assert.equal(isImageArtifact({ path: 'shot.png' }), true);
  assert.equal(isImageArtifact({ path: 'shot.SVG' }), true);
  assert.equal(isImageArtifact({ path: 'notes.txt', mediaType: 'text/plain' }), false);
  // A declared media type wins over the extension: a `.txt` served as a PNG
  // is still a picture, and a `.png` served as text is not.
  assert.equal(isImageArtifact({ path: 'shot.txt', mediaType: 'image/png' }), true);
  assert.equal(isImageArtifact({ path: 'shot.png', mediaType: 'text/plain' }), false);
});

test('an artifact gadget of nothing but images is a gallery', () => {
  assert.equal(
    isImageOnlyArtifactGadget({ artifacts: [{ name: 'a.png', path: 'a.png' }, { name: 'b.jpg', path: 'b.jpg' }] }),
    true
  );
  // One non-image among them makes it a file list.
  assert.equal(
    isImageOnlyArtifactGadget({ artifacts: [{ name: 'a.png', path: 'a.png' }, { name: 'r.html', path: 'r.html' }] }),
    false
  );
  assert.equal(isImageOnlyArtifactGadget({ artifacts: [] }), false);
  // A handover receipt is about a body of work, not a gallery.
  assert.equal(
    isImageOnlyArtifactGadget({ artifacts: [{ name: 'a.png', path: 'a.png' }], handover: { verdict: 'passed' } }),
    false
  );
});

test('an all-image artifact gadget is promoted to the image surface', () => {
  const promoted = promoteArtifactGadgetToImage(
    envelope('artifact', {
      title: 'Visual verification',
      artifacts: [
        { name: 'focus.png', path: '.praxis/session-artifacts/focus.png', mediaType: 'image/png', description: 'After the change' },
        { name: 'wide.jpg', path: '.praxis/session-artifacts/wide.jpg', sizeBytes: 1_024 }
      ]
    })
  ) as { kind: string; payload: { title: string; images: Record<string, unknown>[] } };

  assert.equal(promoted.kind, 'image');
  assert.equal(promoted.payload.title, 'Visual verification');
  assert.equal(promoted.payload.images.length, 2);
  assert.deepEqual(promoted.payload.images[0], {
    name: 'focus.png',
    path: '.praxis/session-artifacts/focus.png',
    mediaType: 'image/png',
    description: 'After the change'
  });
  assert.deepEqual(promoted.payload.images[1], {
    name: 'wide.jpg',
    path: '.praxis/session-artifacts/wide.jpg',
    sizeBytes: 1_024
  });
});

test('a mixed artifact gadget keeps the artifact surface', () => {
  const input = envelope('artifact', {
    title: 'Files',
    artifacts: [{ name: 'a.png', path: 'a.png' }, { name: 'r.html', path: 'r.html', mediaType: 'text/html' }]
  });
  assert.equal(promoteArtifactGadgetToImage(input), input);
});

test('the promotion happens where every gadget is validated, so the renderer sees the image', () => {
  const block = coerceGadgetBlock(
    envelope('artifact', {
      title: 'Visual verification',
      artifacts: [{ name: 'focus.png', path: '.praxis/session-artifacts/focus.png', mediaType: 'image/png' }]
    }),
    'block-1'
  );

  assert.equal(block.type, 'gadget');
  if (block.type !== 'gadget') return;
  assert.equal(block.gadget.kind, 'image');
  // The identity, scope and actions carry over — it is the same gadget, on a
  // surface that shows what it actually holds.
  assert.equal(block.gadget.gadgetId, 'gadget-artifact');
  assert.equal(block.gadget.scope.sessionId, 'session-1');
  assert.ok(block.gadget.fallbackText.includes('focus.png'));
});

test('a client that cannot draw the image surface keeps the artifact surface', () => {
  const input = envelope('artifact', {
    title: 'Visual verification',
    artifacts: [{ name: 'focus.png', path: '.praxis/session-artifacts/focus.png', mediaType: 'image/png' }]
  });

  const outcome = validateGadgetEnvelope(input, {
    capability: { version: GADGET_CONTRACT_VERSION, kinds: ['choice', 'artifact'] }
  });
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
  if (!outcome.ok) return;
  assert.equal(outcome.envelope.kind, 'artifact');
});

test('an image gadget refuses an item that is not a picture', () => {
  const outcome = validateGadgetEnvelope(
    envelope('image', {
      title: 'Pictures',
      images: [{ name: 'notes.txt', path: 'notes.txt', mediaType: 'text/plain' }]
    })
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.path, 'payload.images[0].mediaType');
});

test('an image gadget refuses a path that escapes the workspace', () => {
  const outcome = validateGadgetEnvelope(
    envelope('image', {
      title: 'Pictures',
      images: [{ name: 'x.png', path: '../../etc/passwd.png' }]
    })
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.path, 'payload.images[0].path');
});

test('an image gadget accepts an inline SVG carried in the payload', () => {
  const outcome = validateGadgetEnvelope(
    envelope('image', {
      title: 'Diagram',
      images: [{ name: 'flow.svg', path: 'flow.svg', mediaType: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }]
    })
  );
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
  if (!outcome.ok) return;
  const payload = outcome.envelope.payload as { images: Array<{ content?: string }> };
  assert.equal(payload.images[0].content, '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

test('an image gadget falls back to text a reader can use', () => {
  const outcome = validateGadgetEnvelope(
    envelope('image', {
      title: 'Visual verification',
      images: [{ name: 'focus.png', path: '.praxis/session-artifacts/focus.png', description: 'After the change' }]
    })
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(outcome.envelope.fallbackText.includes('Visual verification'));
  assert.ok(outcome.envelope.fallbackText.includes('focus.png'));
  assert.ok(outcome.envelope.fallbackText.includes('After the change'));
});
