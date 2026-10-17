import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// Semantic search answered MODEL_UNAVAILABLE for good when a repository was registered
// after the model was installed, or when its activation was refused while its index was
// failing: activation only ran at download time, fire-and-forget. Both cases drive the
// real packaged service and the real pinned model.
const executable = process.env.PRAXIS_CODE_INTELLIGENCE_EXE;
const bundle = process.env.PRAXIS_MODEL_BUNDLE;

let app: TestApp | undefined;
let owner: ChildProcess | undefined;
let temporary: string | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (owner && owner.exitCode === null) owner.kill();
  owner = undefined;
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

function fixture(): { data: string; source: string } {
  test.skip(!executable || !bundle, 'Set PRAXIS_CODE_INTELLIGENCE_EXE to a host package and PRAXIS_MODEL_BUNDLE to the pinned model.');
  // The owner's Unix socket lives in the data directory, so keep the path short.
  temporary = fs.mkdtempSync('/tmp/pci-act-');
  const source = path.join(temporary, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Tokens.cs'), 'public class AuthenticationTokenParser { public string ParseBearerToken(string header) => header; }\n');
  return { data: path.join(temporary, 'data'), source };
}

async function launch(data: string): Promise<Page> {
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'gateway-fixture-key',
    PRAXIS_CODE_INTELLIGENCE_EXE: executable!,
    PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY: data,
    PRAXIS_MODEL_BUNDLE: bundle!
  }, { semanticSearchPrompt: true });
  return app.window;
}

// The user's path: Cmd+Shift+F, Semantic, search. Vectors build in the background, so
// search again until they are there; MODEL_UNAVAILABLE must never be the final answer.
async function expectSemanticMatch(win: Page): Promise<void> {
  await win.keyboard.press('ControlOrMeta+Shift+F');
  const dialog = win.getByTestId('code-search-dialog');
  await expect(dialog).toBeVisible();
  await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), 'vector');
  await dialog.getByTestId('code-search-input').fill('read the bearer credential from a header');
  await expect(async () => {
    await dialog.getByTestId('code-search-submit-btn').click();
    await expect(dialog.locator('[data-testid^="code-search-item-"]').first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await expect(dialog).not.toContainText('MODEL_UNAVAILABLE');
}

test('a repository registered after the model is installed gets semantic search', async () => {
  test.setTimeout(180_000);
  const { data, source } = fixture();
  const win = await launch(data);
  // Installs the bundle into the service, as app start does.
  await expect.poll(() => win.evaluate(() => window.praxis.ai.getSemanticModelStatus().then(status => status.installed))).toBe(true);
  // The same register request the search dialog sends for a project's folder.
  const registered = await win.evaluate(root => window.praxis.ai.codeIntelligence({ action: 'register', root }), source);
  expect(registered.error).toBeUndefined();
  expect(registered.warnings ?? []).toEqual([]);
  await expectSemanticMatch(win);
});

test('a repository indexed without the model is caught up when the app starts', async () => {
  test.setTimeout(180_000);
  const { data, source } = fixture();
  // Registered and indexed by an earlier session that never activated the model.
  owner = spawn(executable!, ['serve', '--data', data], { stdio: 'ignore' });
  await expect.poll(() => fs.existsSync(path.join(data, 'owner.json'))).toBe(true);
  const repositoryId = JSON.parse(execFileSync(executable!, ['register', source, '--data', data], { encoding: 'utf8' })).data.repositoryId as string;
  execFileSync(executable!, ['index', repositoryId, '--data', data]);
  const win = await launch(data);
  await expectSemanticMatch(win);
});
