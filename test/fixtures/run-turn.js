import plugin from '../../dist/index.js';

const handlers = new Map();
const api = {
  pluginConfig: {
    publicKey: 'pk-test',
    secretKey: 'sk-test',
    baseUrl: process.argv[2],
  },
  config: {},
  runtime: { version: 'test' },
  logger: {
    info: () => {},
    warn: (message) => console.log(message),
    error: (message) => console.error(message),
  },
  on: (name, handler) => handlers.set(name, handler),
};

plugin.register(api);
const directFlush = process.argv[4] === 'direct';
for (let turn = 0; turn < Number(process.argv[3] || 1); turn += 1) {
  const context = { sessionKey: `test/channel/${turn}` };
  if (directFlush) {
    await handlers.get('gateway_start')({ port: 41892 });
  } else {
    await handlers.get('message_received')(
      { from: 'test-user', role: 'user', content: 'ping' },
      context,
    );
  }
  await handlers.get('agent_end')(
    { success: true, durationMs: 1, messages: [{ role: 'assistant', content: 'pong' }] },
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

await handlers.get('gateway_stop')();
console.log('turn completed');
