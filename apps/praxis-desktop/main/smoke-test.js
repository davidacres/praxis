const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const { registerBoardIpc } = require('./out/main/boardIpc.js');
  const { registerIssueIpc } = require('./out/main/issueIpc.js');
  registerBoardIpc();
  registerIssueIpc();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'out/preload/index.js'),
      contextIsolation: true
    }
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message);
  });

  await win.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));

  let result;
  let error;
  try {
    result = await win.webContents.executeJavaScript(`
    (async () => {
      const boards = await window.ticketManager.board.list({ projectKeys: [], types: [], searchText: '' });
      const details = boards.length ? await window.ticketManager.board.get(boards[0]) : null;
      const firstIssueKey = details && details.issues.length ? details.issues[0].key : null;
      let issueBefore = null;
      let issueAfter = null;
      let commentAdded = false;
      let transitionError = null;
      if (firstIssueKey) {
        issueBefore = await window.ticketManager.issue.get(firstIssueKey);
        await window.ticketManager.issue.addComment(firstIssueKey, 'smoke test comment');
        if (issueBefore.transitions && issueBefore.transitions.length) {
          try {
            await window.ticketManager.issue.transition(firstIssueKey, issueBefore.transitions[0].id);
          } catch (err) {
            transitionError = err instanceof Error ? err.message : String(err);
          }
        }
        issueAfter = await window.ticketManager.issue.get(firstIssueKey);
        commentAdded = issueAfter.comments.some(c => c.body === 'smoke test comment');
      }
      return {
        boardCount: boards.length,
        boardNames: boards.map(b => b.name),
        firstBoardColumns: details ? details.columns.map(c => ({ name: c.name, issueCount: c.issues.length })) : null,
        firstIssueKey,
        statusBefore: issueBefore ? issueBefore.status : null,
        statusAfter: issueAfter ? issueAfter.status : null,
        commentAdded,
        transitionError
      };
    })();
  `);
  } catch (err) {
    error = err instanceof Error ? err.stack || err.message : String(err);
  }

  if (error) {
    console.log('SMOKE_TEST_ERROR', error);
  } else {
    console.log('SMOKE_TEST_RESULT', JSON.stringify(result));
  }
  app.quit();
  setTimeout(() => process.exit(error ? 1 : 0), 500);
});

setTimeout(() => {
  console.log('SMOKE_TEST_TIMEOUT');
  process.exit(1);
}, 15000);
