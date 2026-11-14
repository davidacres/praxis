import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { readJson, validateBundle } from '../../../scripts/session-lab/format.mjs';
import { capture, paneReplay, providerReplay } from './sessionLabHarness';
const mode = process.env.PRAXIS_SESSION_LAB_MODE;
const hold = Number(process.env.PRAXIS_SESSION_LAB_HOLD || 0);
test('Session Lab: capture a real model or replay a saved recording', async () => {
  test.skip(!mode,'Opt in through scripts/session-lab/run.mjs');
  test.setTimeout((600+Math.min(hold,3600))*1000);
  if (mode==='capture') { await capture(); return; }
  const file=path.resolve(process.env.PRAXIS_SESSION_LAB_BUNDLE!);
  const bundle=validateBundle(readJson(file));
  const output=path.resolve(process.env.PRAXIS_SESSION_LAB_OUT || path.join(path.dirname(file),mode==='provider'?'provider-replay':'pane-replay'));
  fs.mkdirSync(output,{recursive:true});
  if(mode==='provider') await providerReplay(bundle,file,output);
  else await paneReplay(bundle,output);
});
