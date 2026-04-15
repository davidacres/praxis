const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.CAPTURE_PORT || 8787);
const outputPath = path.resolve(process.env.CAPTURE_OUTPUT || 'claude-bedrock-capture.json');
const requests = [];
let idleTimer;

function flushAndExit() {
  fs.writeFileSync(outputPath, JSON.stringify(requests, null, 2));
  server.close(() => process.exit(0));
}

function scheduleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(flushAndExit, 1500);
}

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyText: bodyBuffer.toString('utf8'),
      bodyBase64: bodyBuffer.toString('base64')
    });

    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ captured: true }));
    scheduleExit();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`capture server listening on http://127.0.0.1:${port}`);
  console.log(`writing capture to ${outputPath}`);
});