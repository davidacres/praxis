/**
 * An image is not a file row.
 *
 * The `artifact` surface lists *files*: a name, a path, and buttons to open
 * the file in the workspace or copy it into the artifacts folder. A screenshot
 * is none of that — it is a picture the agent wants the user to look at, and
 * giving it the file chrome means the user has to read a card to see a picture.
 *
 * So the host promotes an artifact gadget that carries nothing but images into
 * the `image` surface, which renders the pictures themselves. The promotion is
 * host-side rather than a renderer concern on purpose: the agent's prompt, the
 * wire format and the phone all speak one language, and this is the one place
 * where "an artifact that is only images" becomes "an image".
 */

/** The media types the `image` surface can present. */
const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/svg+xml'
]);

/** The file extensions that identify an image when no media type is given. */
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** Whether an artifact is an image, judged by its media type or its extension. */
export function isImageArtifact(artifact: { path: string; mediaType?: string }): boolean {
  if (artifact.mediaType) return IMAGE_MEDIA_TYPES.has(artifact.mediaType.toLowerCase());
  return IMAGE_EXTENSIONS.test(artifact.path.split(/[?#]/, 1)[0] ?? '');
}

export interface PromotableArtifact {
  name: string;
  path: string;
  mediaType?: string;
  sizeBytes?: number;
  description?: string;
  content?: string;
}

/**
 * Whether an artifact gadget is really a picture.
 *
 * Every artifact has to be an image — a mixed list is a file list, and belongs
 * on the artifact surface. Handover metadata also keeps it there: it is a
 * receipt about a body of work, not a gallery.
 */
export function isImageOnlyArtifactGadget(payload: {
  artifacts?: readonly PromotableArtifact[];
  handover?: unknown;
}): boolean {
  if (payload.handover !== undefined && payload.handover !== null) return false;
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length === 0) return false;
  return payload.artifacts.every(isImageArtifact);
}

/**
 * Rewrite an artifact gadget as an image gadget.
 *
 * Only the shape changes: the identity, the scope, the actions and the
 * producer's own fallback text all carry over, so the gadget stays the same
 * gadget — it just gets a surface that shows what it actually holds.
 */
export function promoteArtifactGadgetToImage(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const envelope = input as Record<string, unknown>;
  if (envelope.kind !== 'artifact') return input;
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return input;
  const record = payload as Record<string, unknown>;
  if (!isImageOnlyArtifactGadget(record as { artifacts?: readonly PromotableArtifact[] })) return input;

  const images = (record.artifacts as PromotableArtifact[]).map(artifact => ({
    name: artifact.name,
    path: artifact.path,
    ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
    ...(artifact.description ? { description: artifact.description } : {}),
    ...(artifact.content !== undefined ? { content: artifact.content } : {})
  }));

  return {
    ...envelope,
    kind: 'image',
    payload: {
      title: typeof record.title === 'string' ? record.title : 'Images',
      images
    }
  };
}
