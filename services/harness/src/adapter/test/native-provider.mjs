import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
let rootCalls = 0;
let childCalls = 0;
let grandchildCalls = 0;
let nested = false;
let goal;
let spawned = false;
let wrote = false;
let cap;
let reasoning;
const server = createServer(async (request, reply) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const child = body.model.startsWith('test/');
  if (body.model === 'test/tertiary') grandchildCalls++;
  const n = child ? ++childCalls : ++rootCalls;
  cap = body.max_tokens ?? body.max_completion_tokens;
  if (!child) reasoning = body.reasoning?.effort ?? body.reasoning_effort;
  const tools = new Set((body.tools ?? []).map((tool) => tool.function.name));
  let finish = 'stop';
  let content = child ? 'Secondary task complete.' : 'Continue working.';
  let call;
  if (body.model === 'test/secondary' && !nested) {
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
  } else if (!child && n === 1) finish = 'length';
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
        command: 'mkdir -p out && printf native-proof > out/proof.txt',
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
          message.params.sessionId === 'root' &&
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
  child.on('exit', (code) => {
    server.close();
    const proof = readFileSync('/workspace/out/proof.txt', 'utf8');
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
    };
    process.stderr.write('NATIVE_PROOF ' + JSON.stringify(result) + '\n');
    process.exit(
      code ||
        !(
          rootCalls > 4 &&
          childCalls > 0 &&
          grandchildCalls > 0 &&
          reasoning === 'max' &&
          goal?.phase === 'complete' &&
          goal.maxGoalRounds > 2 &&
          proof === 'native-proof'
        )
        ? 1
        : 0,
    );
  });
});
