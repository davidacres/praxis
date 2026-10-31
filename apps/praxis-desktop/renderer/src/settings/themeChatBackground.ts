/** Kept browser-safe; core validates the same literal format on persistence. */
export function isChatBackgroundImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2_800_000
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export async function readChatBackgroundImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
    throw new Error('Choose a PNG, JPEG or WebP image up to 2 MB.');
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
  if (!isChatBackgroundImage(data)) throw new Error('The image could not be read.');
  const image = new Image();
  image.src = data;
  try { await image.decode(); } catch { throw new Error('Choose a valid image file.'); }
  return data;
}
