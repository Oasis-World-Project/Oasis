import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { zstdDecompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
let rootCalls = 0;
let childCalls = 0;
let grandchildCalls = 0;
let nested = false;
let goal;
let spawned = false;
let wrote = false;
let cap;
let reasoning;
let overflowSent = false;
let compactions = 0;
let checkpointSeen = false;
const mode = process.env.OASIS_NATIVE_MODE ?? 'fresh';
const execution = JSON.parse(readFileSync('/workspace/in/.oasis-execution.json', 'utf8'));
const sessionId = execution.sessionId;
const persistent = mode === 'persistent';
const attachmentTest = process.env.OASIS_NATIVE_FAULT === 'attachment';
if (attachmentTest) {
  const image = spawn('python3', [
    '-c',
    'from PIL import Image; Image.new("RGB", (8, 8), (100, 50, 200)).save("/workspace/attachment.png")',
  ]);
  await new Promise((resolve, reject) =>
    image.once('exit', (code) => (code ? reject(new Error('image fixture failed')) : resolve())),
  );
}
let verified = false;
function nativeRecords() {
  const archive = readFileSync(
    `/home/node/.dsh/sessions/--workspace--/${sessionId}/session.v4.jsonl.zstd`,
  );
  let offset = 0;
  let log = '';
  while (offset < archive.length) {
    const decoded = zstdDecompressSync(archive.subarray(offset), { info: true });
    log += decoded.buffer;
    offset += decoded.engine.bytesWritten;
  }
  return { archive, records: log.trim().split('\n').map(JSON.parse) };
}
if (persistent && execution.recovering) {
  goal = nativeRecords()
    .records.filter((e) => e.type === 'goal/change')
    .at(-1)?.data.goal;
  spawned = true;
  wrote = true;
}
let historySeen = false;
if (mode !== 'fresh' && !persistent) {
  const sessionDirectory = `/home/node/.dsh/sessions/--workspace--/${sessionId}`;
  mkdirSync(sessionDirectory, { recursive: true });
  if (existsSync('/workspace/in/legacy-session.jsonl.zstd'))
    copyFileSync(
      '/workspace/in/legacy-session.jsonl.zstd',
      `${sessionDirectory}/session.v${process.env.OASIS_NATIVE_GENERATION ?? '4'}.jsonl.zstd`,
    );
  writeFileSync('/workspace/out/legacy.txt', 'legacy-file-kept');
  if (mode === 'recover') writeFileSync('/workspace/out/proof.txt', 'native-proof');
}
const server = createServer(async (request, reply) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const summarizing = JSON.stringify(body.messages.at(-1)).includes(
    'Output only the checkpoint text',
  );
  if (summarizing) compactions++;
  const child = body.model.startsWith('test/');
  if (!summarizing && body.model === 'test/tertiary') grandchildCalls++;
  const n = summarizing ? rootCalls : child ? ++childCalls : ++rootCalls;
  if (!summarizing && !child && process.env.OASIS_NATIVE_FAULT === 'context-overflow') {
    if (overflowSent && JSON.stringify(body.messages).includes('NATIVE_CONTEXT_CHECKPOINT'))
      checkpointSeen = true;
    if (n === 3 && !overflowSent) {
      overflowSent = true;
      reply.writeHead(400, { 'content-type': 'application/json' });
      reply.end(
        JSON.stringify({
          error: {
            code: 'context_length_exceeded',
            message: 'This request exceeds the model maximum context length.',
          },
        }),
      );
      return;
    }
  }
  if (!child && n === 1 && process.env.OASIS_NATIVE_FAULT === 'disconnect') {
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.write('data: {"choices":[{"delta":{"content":"incomplete network reply"}}]}\n\n');
    globalThis.setTimeout(() => reply.destroy(), 20);
    return;
  }
  cap = body.max_tokens ?? body.max_completion_tokens;
  if (!child) reasoning = body.reasoning?.effort ?? body.reasoning_effort;
  const tools = new Set((body.tools ?? []).map((tool) => tool.function.name));
  if (mode === 'refuse') throw new Error('A refused archive must never dispatch a model request');
  if (mode === 'resume' && !child) {
    const history = JSON.stringify(body.messages);
    if (
      !history.includes('LEGACY_CANONICAL_HISTORY_7e82') ||
      !history.includes('LEGACY_TOOL_DURABLE_7e82')
    )
      throw new Error('Legacy history or its tool result was lost');
    historySeen = true;
    const delegation = body.tools?.find((tool) => tool.function.name === 'subagent');
    if (!delegation?.function.parameters.properties.provider)
      throw new Error('Legacy session resumed without current child-model authorization');
  }
  let finish = 'stop';
  let content = summarizing
    ? 'NATIVE_CONTEXT_CHECKPOINT: Continue the existing goal. Delegate to test/secondary, write out/proof.txt, and verify before completing.'
    : child
      ? 'Secondary task complete.'
      : 'Continue working.';
  let call;
  if (summarizing) {
    // 原生压缩器的辅助模型请求只返回摘要，不驱动第二套 Agent Loop。
  } else if (persistent && !execution.recovering && wrote && !child) {
    writeFileSync('/workspace/project/provider-waiting', 'durable');
    return; // 故障注入：真实供应商长调用尚未返回时杀死宿主控制进程。
  }
  if (persistent && execution.recovering && !verified && !child) {
    if (!JSON.stringify(body.messages).includes('DURABLE_WORKSPACE_CREATED'))
      throw new Error('Native history lost across process crash');
    verified = true;
    call = {
      name: 'bash',
      args: {
        description: 'verify durable workspace',
        command:
          'test -x node_modules/.bin/proof && test "$(cat project/invocations)" = 1 && test "$(cat src/marker.txt)" = durable-source && test "$(node_modules/.bin/proof)" = native-proof && printf DURABLE_WORKSPACE_VERIFIED',
      },
    };
  } else if (body.model === 'test/secondary' && !nested) {
    nested = true;
    call = {
      name: 'subagent',
      args: {
        description: 'check nested routing',
        prompt: 'Reply complete.',
        provider: 'openrouter',
        model: 'test/tertiary',
      },
    };
  } else if (!child && n === 1 && mode === 'fresh') finish = 'length';
  else if (!child && n === 2 && attachmentTest)
    call = { name: 'read_image', args: { file_path: '/workspace/attachment.png' } };
  else if (!child && n === 2 && process.env.OASIS_NATIVE_FAULT === 'context-overflow')
    content = `CANONICAL_NATIVE_HISTORY ${'Historical engineering detail. '.repeat(6000)}`;
  else if (!child && n >= 4 && !spawned) {
    if (!tools.has('subagent')) throw new Error('subagent missing');
    spawned = true;
    call = {
      name: 'subagent',
      args: {
        description: 'check secondary routing',
        prompt: 'Reply that your task is complete.',
        provider: 'openrouter',
        model: 'test/secondary',
      },
    };
  } else if (!child && childCalls && !wrote) {
    if (!tools.has('bash')) throw new Error('bash missing: ' + [...tools].join(','));
    wrote = true;
    call = {
      name: 'bash',
      args: {
        description: 'write acceptance proof',
        command: persistent
          ? `mkdir -p out src project node_modules/.bin; printf durable-source > src/marker.txt; printf 1 > project/invocations; printf '#!/bin/sh\nprintf native-proof\n' > project/proof.sh; chmod +x project/proof.sh; ln -s ../../project/proof.sh node_modules/.bin/proof; printf native-proof > out/proof.txt; printf DURABLE_WORKSPACE_CREATED`
          : 'mkdir -p out && printf native-proof > out/proof.txt',
      },
    };
  } else if (
    !child &&
    wrote &&
    goal?.phase === 'active' &&
    !JSON.stringify(body.messages.at(-1)).includes('GOAL_TOOL_AUTHORITY_REQUIRED') &&
    !JSON.stringify(body.messages.at(-1)).includes('complete and blocked require')
  ) {
    call = {
      name: 'update_goal',
      args: { goal_id: goal.id, revision: goal.revision, action: 'complete' },
    };
  } else if (!child && goal?.phase === 'complete') content = 'Verified and complete.';
  const delta = call
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call-${n}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }
    : { role: 'assistant', content };
  reply.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (choices, usage) =>
    `data: ${JSON.stringify({ id: `chat-${n}`, model: body.model, object: 'chat.completion.chunk', created: 1, choices, ...(usage ? { usage } : {}) })}\n\n`;
  reply.end(
    frame([{ index: 0, delta, finish_reason: null }]) +
      frame([{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : finish }], {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20,
      }) +
      'data: [DONE]\n\n',
  );
});
server.listen(0, '127.0.0.1', () => {
  const child = spawn('dsh', ['--profile', 'oasis'], {
    env: {
      ...process.env,
      OASIS_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      OASIS_MODEL: 'test/root',
      OASIS_RUN_KEY: 'offline-only',
      DSH_MAX_TOKENS_AS_SUCCESS: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      try {
        const message = JSON.parse(line);
        if (
          message.method === 'session.event' &&
          message.params.sessionId === sessionId &&
          message.params.event.type === 'goal/change'
        )
          goal = message.params.event.data.goal;
      } catch {
        /* Non-protocol diagnostics are ignored by this fixture. */
      }
    }
    process.stdout.write(chunk);
  });
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
  child.on('exit', async (code) => {
    server.close();
    if (mode === 'refuse') {
      process.stderr.write(`NATIVE_REFUSED ${rootCalls}\n`);
      process.exit(code || rootCalls ? 1 : 0);
    }
    const proof = readFileSync('/workspace/out/proof.txt', 'utf8');
    const { archive, records } = nativeRecords();
    const policies = records.filter((event) => event.type === 'subagent/model-selection-policy');
    if (mode === 'recover')
      goal = records.filter((event) => event.type === 'goal/change').at(-1)?.data.goal;
    mkdirSync('/workspace/evidence', { recursive: true });
    writeFileSync('/workspace/evidence/session.jsonl.zstd', archive);
    let attachmentRecovered = false;
    if (attachmentTest) {
      const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
      const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
      const { LocalAttachmentStore } = await import(
        pathToFileURL(require.resolve('@deepseek-ai/dsh-attachment-local')).href
      );
      cpSync('/home/node/.dsh/sessions', '/workspace/evidence/recovered', { recursive: true });
      const ref = records
        .flatMap((event) => event.data?.message?.content ?? [])
        .find((block) => block.type === 'image')?.attachment;
      if (!ref) throw new Error('Native read_image did not record an attachment reference');
      const restored = new LocalAttachmentStore(new Context(), {
        dshHome: '/workspace/evidence/recovered',
      });
      await restored.readImage(ref);
      attachmentRecovered = true;
    }
    const result = {
      code,
      rootCalls,
      childCalls,
      grandchildCalls,
      cap,
      reasoning,
      phase: goal?.phase,
      maxGoalRounds: goal?.maxGoalRounds,
      proof,
      policyCount: policies.length,
      compactions,
      checkpointSeen,
      attachmentRecovered,
      compactionSummaries: records.filter((event) => event.type === 'compaction/summary').length,
      failedCompactions: records.filter(
        (event) => event.type === 'compaction/end' && event.data.error,
      ).length,
      policyModels: policies[0]?.data.allowedModels.map((model) => model.model),
      ...(mode === 'resume'
        ? { historySeen, legacyOutput: readFileSync('/workspace/out/legacy.txt', 'utf8') }
        : {}),
    };
    process.stderr.write('NATIVE_PROOF ' + JSON.stringify(result) + '\n');
    process.exit(
      code ||
        !(persistent
          ? execution.recovering &&
            verified &&
            goal?.phase === 'complete' &&
            proof === 'native-proof'
          : mode === 'recover'
            ? rootCalls === 0 && goal?.phase === 'complete'
            : rootCalls > 4 &&
              childCalls > 0 &&
              grandchildCalls > 0 &&
              reasoning === 'max' &&
              goal?.phase === 'complete' &&
              goal.maxGoalRounds > 2 &&
              proof === 'native-proof' &&
              (mode !== 'resume' || (historySeen && result.legacyOutput === 'legacy-file-kept')))
        ? 1
        : 0,
    );
  });
});
