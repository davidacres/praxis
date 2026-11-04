import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ConversationAttachment, WireImageAttachment } from '@praxis/core';

/** Content addressed, profile-owned bytes. Caller supplied filesystem paths are never accepted. */
export class TeamChatAttachments {
  public constructor(private readonly directory: string) {}
  private location(conversationId: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid attachment digest.');
    const owner = createHash('sha256').update(conversationId).digest('hex');
    return path.join(this.directory, owner, digest);
  }
  public async stage(conversationId: string, images: WireImageAttachment[]): Promise<ConversationAttachment[]> {
    if (images.length > 8) throw new Error('At most eight images may be attached.');
    return Promise.all(images.map(async image => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)) throw new Error('Unsupported attachment media type.');
      const bytes = Buffer.from(image.dataBase64, 'base64');
      if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== image.dataBase64) throw new Error('Invalid attachment bytes or size.');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const ref = { id: digest, digest, mediaType: image.mimeType, size: bytes.length };
      const file = this.location(conversationId, digest);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await fs.writeFile(file, JSON.stringify({ ref, image }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await this.resolve(conversationId, [ref]);
      return ref;
    }));
  }
  public async resolve(conversationId: string, refs: readonly ConversationAttachment[]): Promise<WireImageAttachment[]> {
    return Promise.all(refs.map(async ref => {
      const stored = JSON.parse(await fs.readFile(this.location(conversationId, ref.digest), 'utf8'));
      const bytes = Buffer.from(stored.image.dataBase64, 'base64');
      if (stored.ref.id !== ref.id || stored.ref.mediaType !== ref.mediaType || bytes.length !== ref.size ||
          createHash('sha256').update(bytes).digest('hex') !== ref.digest) throw new Error('Attachment integrity or ownership failure.');
      return stored.image as WireImageAttachment;
    }));
  }
}
