import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {createDurableSessionStore, durableStreamEvents} from './durable-session-owner.mjs';
import {createDurableTurnBudget} from './durable-turn-budget.mjs';
import {spendModelRequest, budgetError} from './request-budget.mjs';

const EOF_MESSAGE = 'upstream stream ended before first response: eof';
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

async function fixture(t, respond, {settings = {}, maxRequests = 0} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-model-transport-'));
  const requests = [];
  const toolCalls = [];
  const realFetch = globalThis.fetch;
  let store;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    requests.push(payload);
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const frame = (delta, finish_reason = null) => res.write(sse({id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'fixture', choices: [{index: 0, delta, finish_reason}]}));
    respond({res, frame, payload, call: requests.length});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await store?.disposeAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const runtime = await ModelRuntime.create({authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false});
  runtime.registerProvider('fixture', {api: 'openai-completions', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1024,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]});
  const models = createModels();
  models.setProvider(runtime.getProvider('fixture'));
  const makeStore = () => createDurableSessionStore({sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models, getModelRef: () => ({provider: 'fixture', modelId: 'fixture'}), settings,
    buildTools: () => [{name: 'canvas_nodes_create', label: 'canvas.nodes.create', description: 'Synthetic local write',
      parameters: {type: 'object', properties: {}}, execute: async id => {
        toolCalls.push(id);
        return {content: [{type: 'text', text: 'one completed synthetic write'}]};
      }}],
    authorizeTurn: async () => ({turnId: 'transport-turn', canvasId: 'canvas', permissionMode: 'canvas', open: true}),
    completeTurn: async () => {}});
  store = makeStore();
  const entry = await store.ensureSession('canvas');
  if (maxRequests > 0) globalThis.fetch = (input, options) => {
    // Use the host's persisted dispatch guard at the same fetch boundary.
    entry.budget ||= createDurableTurnBudget(entry, {maxRequests});
    const verdict = spendModelRequest(entry.budget);
    if (!verdict.allowed) {entry.budget.failure = verdict; throw budgetError(verdict);}
    return realFetch(input, options);
  };
  const submission = await store.submit(entry, {turnId: 'transport-turn', requestId: 'transport-request', permissionMode: 'canvas',
    content: 'write once then summarize', userText: 'write once then summarize', revisionBefore: 1});
  return {store, entry, submission, requests, toolCalls,
    reopenHistory: async () => {
      await store.disposeAll();
      store = makeStore();
      return store.history('canvas', entry.sessionId);
    }};
}

function answer({res, frame}, text) {
  frame({role: 'assistant', content: text});
  frame({}, 'stop');
  res.end('data: [DONE]\n\n');
}

test('official Durable retries gateway EOF in the same submission without replaying a completed tool', {timeout: 20000}, async t => {
  const f = await fixture(t, response => {
    if (response.call === 1) {
      response.frame({role: 'assistant', tool_calls: [{index: 0, id: 'one-stable-tool', type: 'function',
        function: {name: 'canvas_nodes_create', arguments: '{}'}}]});
      response.frame({}, 'tool_calls');
      response.res.end('data: [DONE]\n\n');
    } else if (response.call === 2) {
      response.res.end(sse({error: {message: EOF_MESSAGE}}));
    } else answer(response, 'completed after official retry');
  });
  const events = [];
  const record = await f.store.wait(f.entry, f.submission, {onEvent: event => {events.push(event);}});
  assert.equal(record.error, null);
  assert.equal(record.reply, 'completed after official retry');
  assert.equal(record.submissionId, f.submission.id);
  assert.equal(record.requestId, 'transport-request');
  assert.equal(f.requests.length, 3);
  assert.equal(f.toolCalls.length, 1);
  assert(f.requests[2].messages.some(message => message.role === 'tool'));
  assert.equal((await f.submission.status(BACKGROUND_CONTEXT)).status, 'done');
  const progress = events.flatMap(durableStreamEvents).filter(event => event.phase?.startsWith('retry'));
  assert.deepEqual(progress, [{type: 'lifecycle', phase: 'retry', attempt: 1, reason: 'network'}, {type: 'lifecycle', phase: 'retry_end', attempt: 1}]);
  const view = await f.entry.root.context(BACKGROUND_CONTEXT);
  const errors = view.entries.flatMap(item => item.model || []).filter(message => message.role === 'assistant' && message.stopReason === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorMessage, `Network error: ${EOF_MESSAGE}`);
  const history = await f.reopenHistory();
  assert.equal(history.turns.length, 1);
  assert.equal(history.turns[0].reply, record.reply);
  assert.equal(history.turns[0].submissionId, f.submission.id);
  assert.equal(f.requests.length, 3);
  assert.equal(f.toolCalls.length, 1);
});

test('Stop during official EOF backoff prevents another request', {timeout: 15000}, async t => {
  const f = await fixture(t, ({res}) => res.end(sse({error: {message: EOF_MESSAGE}})));
  let retryReady;
  const retry = new Promise(resolve => {retryReady = resolve;});
  const waiting = f.store.wait(f.entry, f.submission, {onEvent: event => {
    if (event.type === 'auto_retry_start') retryReady();
  }});
  await retry;
  await f.store.stop(f.entry, 'transport-request');
  const record = await waiting;
  assert.equal(record.cancelled, true);
  assert.equal(record.error, null);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.submission.status(BACKGROUND_CONTEXT)).reason, 'aborted');
  const history = await f.reopenHistory();
  assert.equal(history.turns[0].cancelled, true);
  assert.equal(f.requests.length, 1);
});

test('EOF preserves the host policy of two official Durable retries', {timeout: 15000}, async t => {
  const f = await fixture(t, ({res}) => res.end(sse({error: {message: EOF_MESSAGE}})));
  const events = [];
  const record = await f.store.wait(f.entry, f.submission, {onEvent: event => {events.push(event);}});
  assert.equal(record.errorReason, 'model_error');
  assert.equal(record.error, `Network error: ${EOF_MESSAGE}`);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(events.filter(event => event.type === 'auto_retry_start').map(event => event.attempt), [1, 2]);
});

for (const [label, message] of [
  ['authentication', '401 Unauthorized: invalid API key'],
  ['quota', `insufficient_quota: ${EOF_MESSAGE}`],
  ['balance', `insufficient balance: ${EOF_MESSAGE}`],
  ['billing', `billing account disabled: ${EOF_MESSAGE}`],
  ['request budget', 'turn_request_budget_exhausted'],
  ['tool budget', 'turn_tool_step_budget_exhausted'],
  ['context overflow', 'context length exceeded'],
  ['unclassified EOF', 'unexpected EOF'],
  ['content parse EOF', 'EOF while decoding JSON'],
]) test(`${label} remains terminal without new retries`, {timeout: 15000}, async t => {
  const f = await fixture(t, ({res}) => res.end(sse({error: {message}})));
  const events = [];
  const record = await f.store.wait(f.entry, f.submission, {onEvent: event => {events.push(event);}});
  assert.equal(record.error, message);
  assert.equal(record.errorReason, 'model_error');
  assert.equal(f.requests.length, 1);
  assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0);
});

test('official EOF retry cannot dispatch past the persisted turn request budget', {timeout: 15000}, async t => {
  const f = await fixture(t, ({res}) => res.end(sse({error: {message: EOF_MESSAGE}})),
    {maxRequests: 1, settings: {retry: {maxRetries: 2, baseDelayMs: 1}}});
  const record = await f.store.wait(f.entry, f.submission);
  assert.equal(record.errorReason, 'turn_request_budget_exhausted');
  assert.equal(f.requests.length, 1);
  assert.equal(f.entry.budget.requests, 1);
  assert.equal(createDurableTurnBudget(f.entry, {maxRequests: 1}).requests, 1);
  assert.equal((await f.reopenHistory()).turns[0].errorReason, 'turn_request_budget_exhausted');
  assert.equal(f.requests.length, 1);
});
