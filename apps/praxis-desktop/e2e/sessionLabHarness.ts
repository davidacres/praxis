// Live capture is opt-in. The functional suite exercises both offline replay routes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';
import { openFromPalette } from './navigation';
import { VERSION, now, readJson, writeJson, loadTaps, sanitizer, validateBundle } from '../../../scripts/session-lab/format.mjs';
import { modelEvidence, TimelinePlayer, recordedReplies } from '../../../scripts/session-lab/replay.mjs';

const root = path.resolve(__dirname, '../../..');
const lab = path.join(root, 'scripts/session-lab');
const defaultScenario = {
  id: 'read-and-follow-up-v1',
  fixture: 'Project code: ORBIT-742\nRetry policy: Retry transient failures twice, then report the failure.\n',
  prompts: [
    'Read fixture.txt in the working folder. Do not modify any files. Give a short summary with the exact project code, a bullet list of the retry policy, and a fenced code block showing a two-retry example. Keep the answer under 180 words.',
    'What was the project code you read in the previous turn? Reply with it and one sentence explaining the retry policy. Do not read the file again.'
  ]
};
const scenario = process.env.PRAXIS_SESSION_LAB_SCENARIO ? readJson(path.resolve(process.env.PRAXIS_SESSION_LAB_SCENARIO)) : defaultScenario;
if (scenario.prompts?.length !== 2 || new Set(scenario.prompts).size !== 2 || !scenario.prompts.every((p:any)=>typeof p==='string' && p.length>0) || typeof scenario.fixture!=='string') throw new Error('Scenario requires fixture and exactly two distinct nonempty prompts');
const toolMode = process.env.PRAXIS_SESSION_LAB_TOOL_MODE || 'read-only';
const permission = process.env.PRAXIS_SESSION_LAB_PERMISSION || 'manual';
const headed = process.env.PRAXIS_SESSION_LAB_HEADED === '1';
const hold = Number(process.env.PRAXIS_SESSION_LAB_HOLD || 0);

async function screenshot(app: TestApp, file: string) {
  await expect(app.window.getByTestId('session-chat-thread')).toBeVisible();
  await app.window.screenshot({ path: file });
}
async function holdOpen(app: TestApp) {
  if (hold > 0) {
    console.log(`Session Lab ready for inspection for ${hold}s`);
    await app.window.waitForTimeout(Math.min(hold, 3600) * 1000);
  }
}
function seed(provider: string, command: string, model: string, effort: string, cwd?: string) {
  return { ai: { activeProvider: provider, ...(cwd ? { workingDirectory: cwd } : {}),
    providers: { [provider]: { enabled: true, cliPath: command, defaultModel: model, modelReasoningDefaults: { [model]: effort } } } } };
}
async function startFromComposer(app: TestApp, prompt: string, model: string, tools = toolMode, permissions = permission) {
  const page = app.window;
  const available = await page.evaluate(async () => {
    const settings = await window.praxis.settings.get();
    return window.praxis.ai.listCliModelOptions(settings.ai.activeProvider);
  });
  if (!available?.options.some(option => option.value === model)) throw new Error(`Requested model is unavailable: ${model}`);
  const chip = page.getByTestId('new-session-model-chip');
  await expect(chip).toBeEnabled({ timeout: 60000 });
  await chip.click();
  const option = page.getByTestId(`new-session-model-option-${model}`);
  if (await option.count()) await option.click();
  else {
    const fallback = page.getByTestId('new-session-model-option-default');
    await fallback.click();
  }
  await chooseOption(page.getByTestId('new-session-tool-mode'), tools);
  await page.getByTestId('new-session-permission-chip').click();
  await page.getByTestId(`new-session-permission-option-${permissions}`).click();
  await page.locator('textarea.composer-input').fill(prompt);
  await page.getByTestId('new-session-submit').click();
}
async function completed(app: TestApp, messages: number) {
  await expect.poll(async () => app.window.evaluate(async count => {
    const rows = await window.praxis.ai.listSessions();
    if (!rows[0]) return 'missing';
    const record = await window.praxis.ai.getSession(rows[0].issueKey);
    if (record?.state === 'failed' || record?.state === 'aborted') throw new Error(JSON.stringify(record));
    return record?.state === 'completed' && record.events.filter(event => event.type === 'message').length >= count;
  }, messages), { timeout: 240000, intervals: [250, 500, 1000] }).toBe(true);
  return app.window.evaluate(async () => {
    const rows = await window.praxis.ai.listSessions();
    return window.praxis.ai.getSession(rows[0].issueKey);
  });
}

export async function capture() {
  const provider = process.env.PRAXIS_SESSION_LAB_PROVIDER || 'codex-cli';
  const model = process.env.PRAXIS_SESSION_LAB_MODEL || 'gpt-6.1-sol';
  const effort = process.env.PRAXIS_SESSION_LAB_EFFORT || 'medium';
  const command = process.env.PRAXIS_SESSION_LAB_COMMAND || 'codex-acp';
  const args = JSON.parse(process.env.PRAXIS_SESSION_LAB_ARGS || '[]');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('--args must be a JSON string array');
  const output = path.resolve(process.env.PRAXIS_SESSION_LAB_OUT || path.join(root, 'output/playwright/session-lab', `${Date.now()}-${model.replace(/[^a-z0-9-]/gi, '_')}`));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const privateDir = path.join(output, 'private');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-session-lab-')));
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), scenario.fixture);
  spawnSync('git', ['init', '-q', workspace]);
  const origin = now();
  const configFile = path.join(privateDir, 'config.json');
  writeJson(configFile, { command, args, origin, privateDir });
  const timeline: any[] = [];
  const actions: any[] = [];
  const checkpoints: any[] = [];
  const manifest: any = {
    schemaVersion: VERSION, status: 'incomplete', startedAt: new Date().toISOString(),
    provider, model, effort, toolMode, permissionMode: permission, transport: 'acp',
    versions: { node: process.version, adapter: spawnSync(command, [...args, '--version'], {encoding:'utf8',timeout:10000}).stdout?.trim(),
      codex: provider === 'codex-cli' ? spawnSync(command, [...args, 'cli', '-V'], {encoding:'utf8',timeout:10000}).stdout?.trim() : undefined,
      codexOnPath: provider === 'codex-cli' ? spawnSync('codex', ['--version'], {encoding:'utf8',timeout:10000}).stdout?.trim() : undefined },
    revision: spawnSync('git', ['rev-parse', 'HEAD'], {cwd:root,encoding:'utf8'}).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status','--porcelain'], {cwd:root,encoding:'utf8'}).stdout.trim()),
    scenario, timeline, actions, checkpoints, capabilities: { tools: 'required', modelSelection: 'required', cancellation: 'not-tested', permissions: 'not-tested', resume: 'observed-in-wire' }
  };
  writeJson(path.join(privateDir, 'manifest.json'), manifest);
  let app: TestApp | undefined;
  let profile = '';
  try {
    app = await launchTestApp(seed(provider, path.join(lab, 'acp-tap.mjs'), model, effort, workspace), undefined,
      { PRAXIS_SESSION_LAB_CONFIG: configFile }, { headed, demoMode: false });
    profile = app.userDataDir;
    app.window.setDefaultTimeout(15000);
    await app.window.exposeFunction('sessionLabCapture', (payload: any) => {
      const row = { at: Math.max(now() - origin, timeline.at(-1)?.at || 0), payload };
      timeline.push(row);
      fs.appendFileSync(path.join(privateDir, 'session.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
    });
    // A raw observer only: unlike application subscribers, it must retain unassembled deltas.
    await app.window.evaluate(() => window.praxis.ai.onSessionChanged(payload => (window as any).sessionLabCapture(payload)));
    actions.push({ at: now()-origin, type: 'submit', prompt: scenario.prompts[0] });
    await startFromComposer(app, scenario.prompts[0], model);
    const first = await completed(app, 1);
    expect(first?.responseText?.trim()).toBeTruthy();
    if (scenario === defaultScenario) expect(first?.responseText).toContain('ORBIT-742');
    expect(first?.events.some(event => event.type === 'tool_start')).toBe(true);
    checkpoints.push({ turn:1, record:first, text: await app.window.getByTestId('session-chat-thread').innerText() });
    await screenshot(app, path.join(output, 'live-turn-1.png'));
    actions.push({ at: now()-origin, type:'follow-up', prompt:scenario.prompts[1] });
    await app.window.getByTestId('session-follow-up-input').fill(scenario.prompts[1]);
    await app.window.getByTestId('session-follow-up-send').click();
    const final = await completed(app, 2);
    expect(final?.responseText?.trim()).toBeTruthy();
    if (scenario === defaultScenario) expect(final?.responseText).toContain('ORBIT-742');
    checkpoints.push({ turn:2, record:final, text: await app.window.getByTestId('session-chat-thread').innerText() });
    await screenshot(app, path.join(output, 'live-turn-2.png'));
    await holdOpen(app);
    manifest.status = 'complete';
  } catch (error) {
    manifest.failure = String(error);
    if (app && !app.window.isClosed()) {
      await app.window.screenshot({path:path.join(output,'live-failed.png')}).catch(()=>{});
      manifest.diagnostics = await app.window.evaluate(async () => ({sessions:await window.praxis.ai.listSessions(), logs:await window.praxis.log.getRecent()})).catch(()=>null);
    }
    throw error;
  } finally {
    if (app) await closeTestApp(app);
    writeJson(path.join(privateDir, 'manifest.json'), manifest);
    try {
      manifest.processes = loadTaps(privateDir);
      manifest.modelEvidence = modelEvidence(manifest.processes, model);
      const frames = manifest.processes.flatMap((process:any) => process.frames);
      manifest.capabilities = {
        tools: checkpoints[0]?.record.events.some((event:any)=>event.type==='tool_start') ? 'observed' : 'not-observed',
        modelSelection: manifest.modelEvidence.accepted ? 'acknowledged' : 'not-confirmed',
        reportedModel: manifest.modelEvidence.reported.length ? 'observed' : 'not-reported',
        usage: frames.some((frame:any)=>frame.message.result?.usage) ? 'observed' : 'not-reported',
        continuation: frames.filter((frame:any)=>frame.direction==='to-agent' && ['session/load','session/resume'].includes(frame.message.method)).map((frame:any)=>frame.message.method),
        advertised: frames.filter((frame:any)=>frame.direction==='from-agent' && frame.message.result?.agentCapabilities).map((frame:any)=>frame.message.result.agentCapabilities),
        cancellation: {status:'not-tested',reason:'The baseline scenario completes both turns'},
        permissions: {status:'not-tested',reason:'The baseline scenario does not request a privileged operation'}
      };
      if (manifest.status === 'complete' && !manifest.modelEvidence.accepted) {
        manifest.status = 'incomplete'; manifest.failure = 'Requested model was not acknowledged by the adapter';
      }
      writeJson(path.join(privateDir, 'manifest.json'), manifest);
      if (manifest.status === 'complete') {
        const clean = sanitizer([[workspace, '<WORKSPACE>'],[profile,'<PROFILE>'],[root,'<REPOSITORY>'],[os.homedir(),'<HOME>']]);
        // Raw byte rows remain private. The replay format contains sanitised decoded ACP frames.
        const publicBundle = clean({...manifest, processes:manifest.processes.map(({name,frames,rows}:any)=>({name,frames,lifecycle:rows.filter((r:any)=>r.kind!=='bytes'), stderr:rows.filter((r:any)=>r.direction==='stderr').map((r:any)=>({at:r.at,text:Buffer.from(r.bytes,'base64').toString('utf8')}))}))});
        validateBundle(publicBundle);
        writeJson(path.join(output, 'recording.json'), publicBundle);
        console.log(`SESSION_LAB_BUNDLE=${path.join(output,'recording.json')}`);
        console.log(`Model accepted: ${publicBundle.modelEvidence.accepted}; reported: ${publicBundle.modelEvidence.reported.join(', ') || 'not reported'}`);
      }
    } finally { fs.rmSync(workspace, {recursive:true,force:true}); }
  }
  expect(manifest.status, manifest.failure).toBe('complete');
}

export async function paneReplay(bundle: any, output: string) {
  const app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
    PRAXIS_CODEX_CLI: path.join(lab,'offline-no-cli'), PRAXIS_CLAUDE_CLI: path.join(lab,'offline-no-cli')
  }, {headed, demoMode:false});
  app.window.setDefaultTimeout(15000);
  let player: any;
  let controls: Promise<unknown> = Promise.resolve();
  let mutationCalls = 0;
  try {
    await app.overrideChannel('aiUsage:providerSnapshot', ([provider]) => ({provider, fetchedAt: bundle.startedAt, windows: [], unavailableReason:'Account usage is unavailable during recorded playback', unavailableReasonCode:'not-supported'}));
    await app.overrideChannel('aiUsage:providerSnapshots', () => ({snapshots:[],checkedAt:bundle.startedAt}));
    let current: any;
    let submitted = false;
    let replaySubmissions = 0;
    await app.window.clock.setFixedTime(new Date(bundle.startedAt));
    const blocked = ['ai:delegate','ai:continueSession','ai:abort','ai:respondToPermission','ai:updateSessionModel','ai:updateSessionReasoningEffort','ai:updateSessionPermissionMode','ai:updateSessionToolAccess','ai:handoverSession','ai:runSessionCommand','ai:switchSessionMode','ai:setAcpMode','ai:startConversation','ai:sendConversationMessage','ai:stopConversation','ai:setWorktree','ai:removeWorktree','ai:undoToolFileChange'];
    for (const channel of blocked) await app.overrideChannel(channel, () => { mutationCalls++; throw new Error('Recorded playback is offline'); });
    await app.overrideChannel('ai:continueSession', ([key, message]) => {
      const replies = current?.events?.filter((event:any)=>event.type==='message').length;
      if (submitted || current?.state !== 'completed' || replies !== 1 || key !== current.issueKey || message !== bundle.scenario.prompts[1]) {
        throw new Error('Only the recorded follow-up is available at its recorded turn boundary');
      }
      submitted = true; replaySubmissions++; player.play();
    });
    await app.overrideChannel('ai:listSessions', () => current ? [current] : []);
    await app.overrideChannel('ai:getSession', () => current);
    player = new TimelinePlayer(bundle.timeline, async (row: any, whole: any) => {
      current = whole;
      await app.window.clock.setFixedTime(new Date(Date.parse(bundle.startedAt) + row.at));
      await app.emitEvent('ai:sessionChanged', row.payload);
      const eligible = whole.state === 'completed' && whole.events.filter((event:any)=>event.type==='message').length === 1 && !submitted;
      if (eligible) player.pause();
      await app.window.evaluate(({index,total,eligible}:any) => {
        (window as any).sessionLabCanSubmit = eligible;
        (window as any).sessionLabLockComposer?.();
        const status = document.querySelector('#session-lab-status');
        if (status) status.textContent = `${index+1} / ${total}`;
      }, {index:player.index,total:bundle.timeline.length,eligible});
    });
    await player.restart();
    // Replay the same conversation route used by the real composer, rather than Agent Details.
    await openFromPalette(app.window, 'Conversations');
    await app.window.getByTestId(`easymode-session-card-${current.issueKey}`).click();
    // The recording covers chat, not a live filesystem. Keep workspace inspection closed.
    const aux = app.window.getByTestId('titlebar-aux-toggle');
    if (await aux.getAttribute('aria-pressed') === 'true') await aux.click();
    await app.window.exposeFunction('sessionLabControl', (command: string, value?: number) => {
      controls = controls.then(async () => {
        if (command === 'pause') { player.pause(); await player.inFlight; }
        if (command === 'step') { player.pause(); await player.step(); }
        if (command === 'restart') { submitted = false; await player.restart(); }
        if (command === 'play') player.play();
        if (command === 'speed') { player.pause(); player.speed = value; player.play(); }
      });
      return controls;
    });
    await app.window.evaluate(({provider,model}:any) => {
      const panel = document.createElement('aside');
      panel.id = 'session-lab-controls'; panel.setAttribute('aria-label','Recording playback');
      panel.style.cssText = 'position:fixed;top:45px;right:16px;z-index:10000;padding:10px;max-width:620px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 20px #0003;font:12px system-ui';
      const label = document.createElement('div'); label.textContent = `Recorded session • ${provider} / ${model} • Offline`;
      panel.append(label);
      for (const [name, command] of [['Play','play'],['Pause','pause'],['Step','step'],['Restart','restart']]) {
        const button = document.createElement('button'); button.textContent = name;
        button.dataset.testid = `session-lab-${command}`;
        button.style.cssText='margin:8px 6px 0 0;padding:5px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px';
        button.onclick = () => void (window as any).sessionLabControl(command);
        panel.append(button);
      }
      for (const speed of [0.5,1,4,20]) {
        const button=document.createElement('button'); button.textContent=`${speed}×`; button.dataset.testid=`session-lab-speed-${speed}`;
        button.style.cssText='margin-right:4px'; button.onclick=()=>void (window as any).sessionLabControl('speed',speed); panel.append(button);
      }
      const status=document.createElement('span'); status.id='session-lab-status'; panel.append(status);
      document.body.append(panel);
      const lock = () => {
        for (const id of ['session-follow-up-input','session-follow-up-send']) {
          const element = document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;
          const disabled = !(window as any).sessionLabCanSubmit;
          if (element && element.disabled !== disabled) element.disabled = disabled;
        }
      };
      (window as any).sessionLabLockComposer = lock;
      new MutationObserver(lock).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
      lock();
    }, bundle);
    // Verify controls through the visible overlay before completing the recording.
    await app.window.getByTestId('session-lab-step').click();
    await expect.poll(()=>player.index).toBe(1);
    await app.window.getByTestId('session-lab-play').click();
    await app.window.getByTestId('session-lab-pause').click();
    await controls;
    const paused = player.index;
    await app.window.waitForTimeout(150);
    expect(player.index).toBe(paused);
    await app.window.getByTestId('session-lab-restart').click();
    await expect.poll(()=>player.index).toBe(0);
    await app.window.getByTestId('session-lab-speed-4').click();
    await expect.poll(()=>player.speed).toBe(4);
    await app.window.getByTestId('session-lab-pause').click();
    await controls;
    // Providers can read a file before speaking, or narrate before calling the tool.
    // Inspect both states in recorded order; never assume one provider's sequence.
    const partial = bundle.timeline.findIndex((row:any)=>row.payload.responseText?.length > 0 && !['completed','failed','aborted'].includes(row.payload.state));
    const tool = bundle.timeline.findIndex((row:any)=>row.payload.activeTurnProgress?.activeToolName);
    const inspections = [{index:partial,kind:'partial'},{index:tool,kind:'tool'}]
      .filter(check=>check.index >= 0).sort((a,b)=>a.index-b.index);
    for (const check of inspections) {
      while (player.index < check.index) await player.step();
      if (check.kind === 'partial') {
        await expect(app.window.locator('[data-testid="session-response"], [data-testid="session-chat-live-turn"]').first()).toBeVisible();
        await expect(app.window.getByTestId('session-chat-assistant')).toHaveCount(0);
      } else {
        await expect(app.window.getByTestId('session-chat-active-tool')).toContainText(bundle.timeline[check.index].payload.activeTurnProgress.activeToolName);
        await screenshot(app,path.join(output,'replay-streaming.png'));
      }
    }
    // Drive the same player to the first completed turn and inspect the intermediate pane.
    const firstCompleted = bundle.timeline.findIndex((row:any)=>row.payload.state==='completed');
    while(player.index < firstCompleted) await player.step();
    expect(current.responseText).toBe(bundle.checkpoints[0].record.responseText);
    await expect(app.window.getByTestId('session-chat-assistant')).toHaveCount(1);
    await screenshot(app,path.join(output,'replay-turn-1.png'));
    await expect(app.window.getByTestId('session-follow-up-input')).toBeEnabled();
    await app.window.getByTestId('session-follow-up-input').fill(bundle.scenario.prompts[1]);
    await app.window.getByTestId('session-follow-up-send').click();
    await expect.poll(()=>replaySubmissions).toBe(1);
    player.pause(); await player.inFlight;
    while(player.index < bundle.timeline.length-1) await player.step();
    expect(current.responseText).toBe(bundle.checkpoints[1].record.responseText);
    expect(current.events).toEqual(bundle.checkpoints[1].record.events);
    const thread=app.window.getByTestId('session-chat-thread');
    await expect(thread).toContainText(bundle.scenario.prompts[1]);
    await expect(app.window.getByTestId('session-chat-assistant')).toHaveCount(current.events.filter((e:any)=>e.type==='message').length);
    // One assistant bubble per recorded reply, not duplicates after restart.
    const expectedMessages=current.events.filter((event:any)=>event.type==='message').length;
    expect(current.state).toBe('completed');
    await expect(app.window.getByTestId('session-follow-up-input')).toBeDisabled();
    await screenshot(app,path.join(output,'replay-turn-2.png'));
    expect(mutationCalls).toBe(0);
    console.log(`Replayed ${bundle.timeline.length} session updates; ${expectedMessages} assistant replies; no execution calls`);
    await holdOpen(app);
  } catch (error) {
    await app.window.screenshot({path:path.join(output,'replay-failed.png')}).catch(()=>{});
    throw error;
  } finally {
    player?.pause();
    await app.restoreChannel('ai:listSessions');
    await app.restoreChannel('ai:getSession');
    await closeTestApp(app);
  }
}

export async function providerReplay(bundle: any, bundleFile: string, output: string, verify?: (app: TestApp, first: any, final: any) => Promise<void>) {
  const workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'praxis-session-replay-')));
  fs.writeFileSync(path.join(workspace,'fixture.txt'),bundle.scenario.fixture);
  spawnSync('git',['init','-q',workspace]);
  const app=await launchTestApp(seed(bundle.provider,path.join(lab,'acp-replay.mjs'),bundle.model,bundle.effort,workspace),undefined,
    {PRAXIS_SESSION_LAB_BUNDLE:bundleFile,OPENAI_API_KEY:undefined,AI_GATEWAY_API_KEY:undefined,PRAXIS_CODEX_CLI:path.join(lab,'offline-no-cli'),PRAXIS_CLAUDE_CLI:path.join(lab,'offline-no-cli')}, {headed,demoMode:false});
  app.window.setDefaultTimeout(15000);
  try {
    await startFromComposer(app,bundle.scenario.prompts[0],bundle.model,bundle.toolMode,bundle.permissionMode);
    const first=await completed(app,1);
    expect(first?.responseText).toBe(recordedReplies(bundle)[0]);
    await app.window.getByTestId('session-follow-up-input').fill(bundle.scenario.prompts[1]);
    await app.window.getByTestId('session-follow-up-send').click();
    const final=await completed(app,2);
    expect(final?.responseText).toBe(recordedReplies(bundle)[1]);
    expect(final?.events.filter(e=>e.type==='message').length).toBe(bundle.checkpoints[1].record.events.filter((e:any)=>e.type==='message').length);
    if (verify) await verify(app, first, final);
    await screenshot(app,path.join(output,'provider-replay.png'));
    await holdOpen(app);
  } finally { await closeTestApp(app); fs.rmSync(workspace,{recursive:true,force:true}); }
}

