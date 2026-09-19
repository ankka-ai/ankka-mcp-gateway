import { createRuntime } from '../test-runtime/runtime.mjs';

const { runtime, dispose } = await createRuntime({ diagnostics: true });
const origin = (await runtime.ready).origin;
console.log(JSON.stringify({
  origin,
  explorer: `${origin}/cdn-cgi/local/explorer`,
  api: `${origin}/cdn-cgi/local/explorer/api`,
  state: `${origin}/state`,
  actions: ['seed', 'advance', 'reset', 'race', 'rollback', 'corrupt'],
  note: 'Synthetic fixture only. POST actions have no body. All outbound requests are blocked. State is discarded on exit.',
}, null, 2));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await dispose();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
