import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { readJson, validateBundle } from '../../../scripts/session-lab/format.mjs';
import { paneReplay, providerReplay } from './sessionLabHarness';
const fixture = path.resolve(__dirname,'fixtures/session-recordings/codex-sol-two-turn.json.br');
for (const route of ['pane','provider']) {
  test(`a recorded real Codex conversation replays offline through the ${route}`,async()=>{
    test.setTimeout(90000);
    const output=test.info().outputPath('session-lab');fs.mkdirSync(output,{recursive:true});
    const bundle=validateBundle(readJson(fixture));
    if(route==='pane') await paneReplay(bundle,output);
    else await providerReplay(bundle,fixture,output);
  });
}
