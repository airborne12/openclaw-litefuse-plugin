import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/run-turn.js', import.meta.url));

async function runTurn(status, turns = 1, mode = 'deferred') {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    requests += 1;
    const responseStatus = Array.isArray(status) ? status[requests - 1] : status;
    if (responseStatus === 'reset') {
      response.destroy();
      return;
    }
    response.writeHead(responseStatus);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fixture, `http://127.0.0.1:${address.port}`, String(turns), mode]);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { ...result, requests };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const status of [502, 'reset', 200]) {
  test(`a turn completes when the trace endpoint responds with ${status}`, async () => {
    const result = await runTurn(status);
    assert.ok(result.requests > 0, `Expected an OTLP request: ${JSON.stringify(result)}`);
    assert.equal(result.code, 0, `Agent process exited with ${result.code}: ${result.stderr}`);
    assert.match(result.stdout, /turn completed/);
    if (status === 200) {
      assert.doesNotMatch(result.stdout, /Trace export failed:/);
    } else {
      assert.match(result.stdout, /Trace export failed:/);
    }
  });
}

test('export resumes after a failed turn', async () => {
  const result = await runTurn([502, 200], 2);
  assert.ok(result.requests >= 2, `Expected both turns to export: ${JSON.stringify(result)}`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Trace export failed: OTLP export failed: HTTP 502/);
  assert.match(result.stdout, /turn completed/);
});

test('direct flush failure does not reject the agent_end hook', async () => {
  const result = await runTurn(502, 1, 'direct');
  assert.ok(result.requests > 0, `Expected an OTLP request: ${JSON.stringify(result)}`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Trace export failed: OTLP export failed: HTTP 502/);
  assert.match(result.stdout, /turn completed/);
});

test('repeated export failures produce one warning per interval', async () => {
  const result = await runTurn(502, 2);
  assert.ok(result.requests >= 2, `Expected both turns to export: ${JSON.stringify(result)}`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((result.stdout.match(/Trace export failed:/g) || []).length, 1);
});

test('a new failure after recovery is logged again', async () => {
  const result = await runTurn([502, 200, 502], 3);
  assert.ok(result.requests >= 3, `Expected all turns to export: ${JSON.stringify(result)}`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((result.stdout.match(/Trace export failed:/g) || []).length, 2);
});
