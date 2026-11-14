import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { readJson } from '../../../scripts/session-lab/format.mjs';
import { providerReplay } from './sessionLabHarness';

for (const provider of ['codex','claude']) {
  test(`${provider} raw conversation retains activity, usage and reported runtime state`, async()=>{
    test.setTimeout(90000);
    const file=path.resolve(__dirname,`fixtures/session-recordings/${provider==='codex'?'codex-sol':'claude-sonnet'}-two-turn.json.br`);
    const bundle=readJson(file);
    const output=test.info().outputPath('presentation'); fs.mkdirSync(output,{recursive:true});
    await providerReplay(bundle,file,output,async(app,first,final)=>{
      const message=first.events.find((e:any)=>e.type==='message');
      expect(message.messageSegments.length).toBeGreaterThan(0);
      expect(message.messageSegments.every((part:any)=>part.messageId)).toBe(true);
      const start=first.events.find((e:any)=>e.type==='tool_start');
      const complete=first.events.find((e:any)=>e.type==='tool_complete');
      expect(complete.data.kind).toBe('read');
      expect(complete.data.toolName).toBe(start.data.toolName);
      expect(complete.data.locations[0].path).toContain('fixture.txt');
      expect(complete.data.argsSummary).toContain('fixture.txt');
      if(provider==='codex') {
        expect(first.responseText).not.toContain('I’ll read');
        expect(message.messageSegments[0].phase).toBe('commentary');
        expect(message.messageSegments[1].phase).toBe('final_answer');
      } else {
        expect(message.messageSegments[0].phase).toBeNull();
        expect(final.tokenUsage.cachedWriteTokens).toBe(27957);
        expect(final.tokenUsage.totalTokens).toBe(76218);
        expect(final.reportedModelId).toBe('claude-sonnet-5-5');
        expect(final.reportedModelUsage.find((row:any)=>row.model==='claude-haiku-5-5').role).toBe('additional');
      }
      const page=app.window;
      const card=page.getByTestId('session-chat-assistant').first();
      await expect(card.locator('.session-message-part > .markdown-body').first()).toHaveCSS('white-space','normal');
      const activity=card.getByTestId('session-work-activity');
      await activity.locator('summary').first().click();
      const tool=activity.getByTestId('session-work-tool');
      await tool.locator('summary').first().click();
      await expect(tool).toContainText('fixture.txt');
      await expect(tool).toContainText('Completed');
      await expect(tool).toContainText('Output not supplied by provider');
      if(provider==='codex') await expect(activity.getByTestId('session-commentary')).toContainText('I’ll read');
      await card.screenshot({path:path.join(output,'activity.png')});
      await activity.locator('summary').first().click();
      const usage=card.getByTestId('session-reported-usage');
      await usage.locator('summary').click();
      if(provider==='claude') {
        await expect(usage).toContainText('25,315');
        await expect(usage).toContainText('claude-haiku-5-5');
        await expect(usage).toContainText('3,205');
      }
      await usage.scrollIntoViewIfNeeded();
      await usage.screenshot({path:path.join(output,'usage.png')});
      const runtime=page.getByTestId('session-runtime-facts');
      await runtime.locator('summary').click();
      await expect(runtime).toContainText('Requested access');
      await expect(runtime).toContainText('read-only');
      await expect(runtime).toContainText(provider==='claude'?'Bypass permissions':'Auto review');
      await expect(runtime).toContainText('Write restrictions have not been verified');
      await runtime.screenshot({path:path.join(output,'runtime.png')});
      // Keep a normal completed-view screenshot too.
      await runtime.locator('summary').click();
      await usage.locator('summary').click();
      const summary=page.getByTestId('session-usage-summary');
      await summary.locator(':scope > summary').click();
      const sessionUsage=summary.getByTestId('session-reported-usage');
      await sessionUsage.locator('summary').click();
      await expect(sessionUsage).toContainText(provider==='claude'?'76,218':'103,462');
      if(provider==='claude') {
        await expect(sessionUsage).toContainText('27,957');
        await expect(sessionUsage).toContainText('3,205');
      }
      await sessionUsage.screenshot({path:path.join(output,'session-usage.png')});
      await summary.locator(':scope > summary').click();
      await page.getByTestId('session-chat-assistant').last().scrollIntoViewIfNeeded();
    });
  });
}
