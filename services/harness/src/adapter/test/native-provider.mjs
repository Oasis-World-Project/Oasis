// 断网容器里的假模型供应商 + 镜像里真实的 dsh：验证对话里一轮依赖的原生行为，费用为 0。
// 根会话一轮的流程：派子代理到 test/secondary（它再派 test/tertiary）→ bash 写 out/proof.txt
// →（附件用例：读一张图）→ 文字收尾。OASIS_NATIVE_FAULT 注入故障。
// OASIS_NATIVE_MODE：fresh 新会话的第一轮；resume 接着上一轮的会话（夹具是上一轮留下的会话记录）；
// refuse 会话记录缺失或损坏，必须拒绝；persistent 控制进程崩溃接管（recovery.test.ts）。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { zstdDecompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const mode = process.env.OASIS_NATIVE_MODE ?? 'fresh';
const fault = process.env.OASIS_NATIVE_FAULT ?? '';
const execution = JSON.parse(readFileSync('/workspace/in/.oasis-execution.json', 'utf8'));
const sessionId = execution.sessionId;
const persistent = mode === 'persistent';
let rootCalls = 0;
let childCalls = 0;
let grandchildCalls = 0;
let nested = false;
// 崩溃接管：子代理和写文件在崩溃前已经做过
let spawned = persistent && execution.recovering;
let wrote = persistent && execution.recovering;
let viewed = false;
let verified = false;
let cap;
let reasoning;
let guideSeen = false;
let historySeen = false;
let hugeSent = false;
let overflowSent = false;
let compactions = 0;
let checkpointSeen = false;
let steerHeld = false;
let steerSeen = false;
const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

// 平台说明和技能：harness 每轮放进 dsh 的用户目录（这里从挂进来的目录复制）
if (existsSync('/workspace/in/guide'))
  cpSync('/workspace/in/guide', '/home/node/.dsh', { recursive: true });
if (fault === 'attachment') {
  const image = spawn('python3', [
    '-c',
    'from PIL import Image; Image.new("RGB", (8, 8), (100, 50, 200)).save("/workspace/attachment.png")',
  ]);
  await new Promise((resolve, reject) =>
    image.once('exit', (code) => (code ? reject(new Error('image fixture failed')) : resolve())),
  );
}
if (mode === 'resume' || mode === 'refuse') {
  const sessionDirectory = `/home/node/.dsh/sessions/--workspace--/${sessionId}`;
  mkdirSync(sessionDirectory, { recursive: true });
  if (existsSync('/workspace/in/previous-session.jsonl.zstd'))
    copyFileSync(
      '/workspace/in/previous-session.jsonl.zstd',
      `${sessionDirectory}/session.v${process.env.OASIS_NATIVE_GENERATION ?? '4'}.jsonl.zstd`,
    );
  // 持久工作目录里上一轮的产出还在
  mkdirSync('/workspace/out', { recursive: true });
  writeFileSync('/workspace/out/proof.txt', 'native-proof');
}
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
const count = (text, marker) => text.split(marker).length - 1;

const server = createServer(async (request, reply) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const history = JSON.stringify(body.messages);
  const summarizing = JSON.stringify(body.messages.at(-1)).includes(
    'Output only the checkpoint text',
  );
  if (summarizing) compactions++;
  const child = body.model.startsWith('test/');
  if (!summarizing && body.model === 'test/tertiary') grandchildCalls++;
  const n = summarizing ? rootCalls : child ? ++childCalls : ++rootCalls;
  if (mode === 'refuse') throw new Error('A refused archive must never dispatch a model request');
  const root = !child && !summarizing;
  if (root) {
    reasoning = body.reasoning?.effort ?? body.reasoning_effort;
    if (history.includes('NATIVE_GUIDE_RULES') && history.includes('NATIVE_SKILL_DESCRIPTION'))
      guideSeen = true;
  }
  if (root && fault === 'context-overflow') {
    if (overflowSent && history.includes('NATIVE_CONTEXT_CHECKPOINT')) checkpointSeen = true;
    if (hugeSent && !overflowSent) {
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
  if (root && n === 1 && fault === 'disconnect') {
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.write('data: {"choices":[{"delta":{"content":"incomplete network reply"}}]}\n\n');
    globalThis.setTimeout(() => reply.destroy(), 20);
    return;
  }
  if (root && fault === 'steer') {
    if (history.includes('NATIVE_STEER_MESSAGE')) steerSeen = true;
    if (spawned && !wrote && !steerHeld) {
      // 这次调用压住不回，让宿主趁在途时发消息（真实场景：模型正在生成时用户插了一句）
      steerHeld = true;
      process.stderr.write('NATIVE_STEER_READY\n');
      await sleep(1500);
    }
  }
  if (root && mode === 'resume') {
    if (
      count(history, 'NATIVE_FIRST_TURN') !== 1 ||
      !history.includes('NATIVE_TOOL_DURABLE') ||
      !history.includes('NATIVE_SECOND_TURN')
    )
      throw new Error('上一轮的话、工具结果或这一轮的话不对');
    const delegation = body.tools?.find((tool) => tool.function.name === 'subagent');
    if (!delegation?.function.parameters.properties.provider)
      throw new Error('恢复原会话后子代理不能再选模型');
    historySeen = true;
  }
  cap = body.max_tokens ?? body.max_completion_tokens;
  const tools = new Set((body.tools ?? []).map((tool) => tool.function.name));
  const content = summarizing
    ? 'NATIVE_CONTEXT_CHECKPOINT: The proof is written to out/proof.txt. Reply that the work is done.'
    : child
      ? 'Secondary task complete.'
      : 'Verified and complete.';
  let call;
  /** 调工具时顺带说的话 */
  let said = null;
  if (summarizing) {
    // 原生压缩器的辅助模型请求只返回摘要，不驱动第二套 Agent Loop。
  } else if (persistent && !execution.recovering && wrote && !child) {
    writeFileSync('/workspace/project/provider-waiting', 'durable');
    return; // 故障注入：模型调用在途时杀死宿主控制进程。
  } else if (persistent && execution.recovering && !verified && !child) {
    if (!history.includes('DURABLE_WORKSPACE_CREATED'))
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
  } else if (child || mode === 'resume') {
    // 子代理文字收尾；接着上一轮的这一轮只回话
  } else if (!spawned) {
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
  } else if (!wrote) {
    if (!tools.has('bash')) throw new Error('bash missing: ' + [...tools].join(','));
    wrote = true;
    call = {
      name: 'bash',
      args: {
        description: 'write acceptance proof',
        command: persistent
          ? `mkdir -p out src project node_modules/.bin; printf durable-source > src/marker.txt; printf 1 > project/invocations; printf '#!/bin/sh\nprintf native-proof\n' > project/proof.sh; chmod +x project/proof.sh; ln -s ../../project/proof.sh node_modules/.bin/proof; printf native-proof > out/proof.txt; printf DURABLE_WORKSPACE_CREATED`
          : 'mkdir -p out && printf native-proof > out/proof.txt && printf NATIVE_TOOL_DURABLE',
      },
    };
    // 上下文溢出用例：这一步的话很长，下一次调用超出上下文，dsh 要自动压缩后在这一轮里接着做
    if (fault === 'context-overflow') {
      hugeSent = true;
      said = `CANONICAL_NATIVE_HISTORY ${'Historical engineering detail. '.repeat(6000)}`;
    }
  } else if (fault === 'attachment' && !viewed) {
    viewed = true;
    call = { name: 'read_image', args: { file_path: '/workspace/attachment.png' } };
  }
  const delta = call
    ? {
        role: 'assistant',
        content: said,
        tool_calls: [
          {
            index: 0,
            id: `call-${child ? 'c' : 'r'}${n}`,
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
      frame([{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], {
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
  child.stdout.pipe(process.stdout);
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
    mkdirSync('/workspace/evidence', { recursive: true });
    writeFileSync('/workspace/evidence/session.jsonl.zstd', archive);
    let attachmentRecovered = false;
    if (fault === 'attachment') {
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
      proof,
      guideSeen,
      historySeen,
      policyCount: policies.length,
      compactions,
      checkpointSeen,
      attachmentRecovered,
      steerSeen,
      compactionSummaries: records.filter((event) => event.type === 'compaction/summary').length,
      failedCompactions: records.filter(
        (event) => event.type === 'compaction/end' && event.data.error,
      ).length,
      policyModels: policies[0]?.data.allowedModels.map((model) => model.model),
    };
    process.stderr.write('NATIVE_PROOF ' + JSON.stringify(result) + '\n');
    const ok = persistent
      ? execution.recovering && verified && proof === 'native-proof'
      : mode === 'resume'
        ? historySeen && rootCalls === 1 && proof === 'native-proof'
        : rootCalls >= 3 &&
          childCalls > 0 &&
          grandchildCalls > 0 &&
          // OpenRouter 原生型号沿用原生档位，Oasis 插件取最高一档（DeepSeek 是 max）
          reasoning === 'max' &&
          guideSeen &&
          proof === 'native-proof';
    process.exit(code || !ok ? 1 : 0);
  });
});
