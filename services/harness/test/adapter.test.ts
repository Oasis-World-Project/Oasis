import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { permissionEnv, sandboxEnv, runtimeFiles } from '../src/adapter/dsh.ts';
import { translateNotification } from '../src/adapter/events.ts';
import { createJsonRpcClient, JsonRpcError } from '../src/adapter/jsonrpc.ts';

const event = (type: string, data: unknown) =>
  ['session.event', { event: { type, data } }] as const;

describe('dsh 事件翻译', () => {
  it('只保留用户真正说的话，丢掉 dsh 自己插的运行时上下文', () => {
    expect(
      translateNotification(
        ...event('user/message', {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '写报告' }],
        }),
      ),
    ).toEqual({ kind: 'user_message', data: { text: '写报告' } });
    expect(
      translateNotification(
        ...event('user/message', {
          source: { kind: 'runtime' },
          content: [{ type: 'text', text: 'ctx' }],
        }),
      ),
    ).toBeUndefined();
  });

  it('工具调用、工具结果（含失败原因）、模型错误、轮次结束、忙闲状态', () => {
    expect(
      translateNotification(
        ...event('tool/call', { callId: 'c1', name: 'write', arguments: '{"path":"out/a.md"}' }),
      ),
    ).toEqual({
      kind: 'tool_call',
      data: {
        callId: 'c1',
        name: 'write',
        arguments: '{"path":"out/a.md"}',
        label: '写文件 out/a.md',
        path: 'out/a.md',
      },
    });
    expect(
      translateNotification(
        ...event('tool/result', {
          message: {
            toolCallId: 'c1',
            isError: true,
            content: [{ type: 'text', text: 'no such file' }],
          },
          error: { name: 'E', code: 'ENOENT', reason: '文件不存在' },
        }),
      ),
    ).toEqual({
      kind: 'tool_result',
      data: { callId: 'c1', ok: false, text: 'no such file', error: '文件不存在' },
    });
    expect(
      translateNotification(
        ...event('turn/end', { reason: { kind: 'error', error: { message: '402' } } }),
      ),
    ).toEqual({ kind: 'error', data: { message: '402' } });
    expect(translateNotification(...event('turn/end', { reason: { kind: 'completed' } }))).toEqual({
      kind: 'turn_end',
      data: { reason: 'completed' },
    });
    expect(translateNotification('session.status', { status: 'idle' })).toEqual({
      kind: 'status',
      data: { status: 'idle' },
    });
    expect(translateNotification(...event('step/start', {}))).toBeUndefined();
  });

  it('只有空白的 AI 发言不记（模型调工具前常吐一段空白）', () => {
    expect(
      translateNotification(
        ...event('assistant/message', { message: { content: [{ type: 'text', text: '  \n' }] } }),
      ),
    ).toBeUndefined();
  });

  it.each(['max-tokens', 'aborted', 'unknown', undefined])(
    '拒绝非 completed 的结束原因：%s',
    (kind) => {
      expect(translateNotification(...event('turn/end', { reason: { kind } }))).toMatchObject({
        kind: 'error',
        data: { reason: kind ?? 'unknown' },
      });
    },
  );

  it('每一步给人看的一句话：命令、oasis-tool 工具、读写文件；参数被截断也认得出', () => {
    const label = (name: string, args: unknown) =>
      translateNotification(
        ...event('tool/call', {
          callId: 'c',
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        }),
      )?.data.label;
    expect(label('bash', { command: 'npm install\nnpm test' })).toBe('运行命令：npm install');
    expect(
      label('bash', {
        command: 'oasis-tool image.generate --prompt "橘猫在窗台上晒太阳" --out out/a.png',
      }),
    ).toBe('生成图片：橘猫在窗台上晒太阳');
    expect(label('bash', { command: 'cd out && oasis-tool wait 1234' })).toBe('等长任务的结果');
    // 放到后台的命令马上结束，之后看它的输出
    expect(
      label('bash', { command: 'oasis-tool wait 1 2 2>&1 | tail -20', run_in_background: true }),
    ).toBe('等长任务的结果（放到后台）');
    expect(label('job_output', { job_id: 'bash-1', wait: true })).toBe('看后台命令的输出');
    expect(label('bash', { command: 'oasis-tool brand.new --x 1' })).toBe('用工具 brand.new');
    expect(label('str_replace_editor', { command: 'view', path: 'a.md' })).toBe('读文件 a.md');
    expect(label('str_replace_editor', { command: 'str_replace', path: 'a.md' })).toBe(
      '改文件 a.md',
    );
    expect(label('edit', { file_path: '/workspace/out/a.css' })).toBe(
      '改文件 /workspace/out/a.css',
    );
    // 参数太长被截断、JSON 不完整
    expect(label('write', `{"path":"out/site/index.html","content":"${'x'.repeat(5000)}`)).toBe(
      '写文件 out/site/index.html',
    );
    expect(label('ask_user_question', {})).toBe('ask_user_question');
  });

  it('进度页要用的：oasis-tool 的工具名和点名的型号，写、改的文件（相对工作目录）', () => {
    const facts = (name: string, args: unknown) => {
      const data = translateNotification(
        ...event('tool/call', { callId: 'c', name, arguments: JSON.stringify(args) }),
      )?.data;
      return { oasisTool: data?.oasisTool, oasisModel: data?.oasisModel, path: data?.path };
    };
    expect(
      facts('bash', {
        command: `oasis-tool image.generate --prompts '["a","b"]' --model x/seedream --out out/a.png`,
      }),
    ).toEqual({ oasisTool: 'image.generate', oasisModel: 'x/seedream', path: undefined });
    expect(facts('bash', { command: 'oasis-tool wait 1 2' })).toMatchObject({ oasisTool: 'wait' });
    expect(facts('bash', { command: 'ls out' })).toMatchObject({ oasisTool: undefined });
    // 查用法不算调用工具
    const help = { command: 'oasis-tool video.generate --help 2>&1 | head -40' };
    expect(facts('bash', help)).toMatchObject({ oasisTool: undefined });
    expect(
      translateNotification(
        ...event('tool/call', { callId: 'c', name: 'bash', arguments: JSON.stringify(help) }),
      )?.data.label,
    ).toBe('看用法：生成视频');
    expect(facts('write', { file_path: '/workspace/out/分镜.md', content: 'x' })).toMatchObject({
      path: 'out/分镜.md',
    });
    expect(facts('edit', { file_path: 'out/a.css' })).toMatchObject({ path: 'out/a.css' });
    expect(facts('str_replace_editor', { command: 'view', path: 'out/a.css' })).toMatchObject({
      path: undefined,
    });
    // 工作目录外、往上跳的不给
    expect(facts('write', { file_path: '/tmp/x' })).toMatchObject({ path: undefined });
    expect(facts('write', { file_path: 'out/../../x' })).toMatchObject({ path: undefined });

    // oasis-tool 存下的文件：输出里「已保存：」那几行（截断前就认出来）
    const saved = (text: string) =>
      translateNotification(
        ...event('tool/result', {
          message: { toolCallId: 'c', content: [{ type: 'text', text }] },
        }),
      )?.data.files;
    expect(
      saved(
        `生成了 2 张图片\n已保存：out/帧-1.png\n已保存：/workspace/out/帧-2.png\n${'x'.repeat(5000)}\n已保存：out/尾.png`,
      ),
    ).toEqual(['out/帧-1.png', 'out/帧-2.png', 'out/尾.png']);
    expect(saved('已保存：/tmp/x.png\n已保存：../x.png')).toBeUndefined();
    // 在用户电脑上：项目里的 .oasis/out/（相对、绝对、反斜杠）都换成 out/；别的绝对路径不给
    expect(
      saved(
        '已保存：.oasis/out/素材/帧.png\n已保存：C:\\proj\\.oasis\\out\\片.mp4\n已保存：D:\\x.png',
      ),
    ).toEqual(['out/素材/帧.png', 'out/片.mp4']);

    // 长任务的进展按任务号：交了没等的、做好了的（连同它的文件）、还在做的、没做出来的
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(
      (x) => `${x.repeat(8)}-0000-4000-8000-000000000000`,
    );
    // 等到的长任务存下的文件后面带任务号，不算进路径
    expect(saved(`已保存：out/片段一.mp4（任务号 ${a}）`)).toEqual(['out/片段一.mp4']);
    const jobs = (text: string) =>
      translateNotification(
        ...event('tool/result', {
          message: { toolCallId: 'c', content: [{ type: 'text', text }] },
        }),
      )?.data.jobs;
    expect(
      jobs(
        `生成视频已提交，要等几分钟；任务号 ${a}。\n已提交，没等结果（任务号 ${a}）。几个都交完后一起等：oasis-tool wait ${a} <别的任务号…>`,
      ),
    ).toEqual([{ id: a, state: 'submitted' }]);
    expect(
      jobs(
        [
          `做好了（任务号 ${a}）`,
          '视频生成好了',
          `已保存：out/片段一.mp4（任务号 ${a}）`,
          '花费：$0.2125',
          `做好了（任务号 ${b}）`,
          `已保存：/workspace/out/片段二.mp4（任务号 ${b}）`,
          `还没做好（任务号 ${c}）。先做别的，过一会儿运行：oasis-tool wait ${c}`,
          `oasis-tool 出错：内容不合规（任务号 ${d}，供应商没做出来，没有收费；要再试就加 --new true 重新提交）`,
        ].join('\n'),
      ),
    ).toEqual([
      { id: a, state: 'done', files: ['out/片段一.mp4'] },
      { id: b, state: 'done', files: ['out/片段二.mp4'] },
      { id: c, state: 'waiting' },
      { id: d, state: 'failed' },
    ]);
    // AI 只看了末几行（| tail），「做好了」那句截掉了；反复等，同一个文件存了两次
    expect(
      jobs(
        [
          `已保存：out/音乐一.mp3（任务号 ${a}）`,
          '花费：$0.1500',
          `做好了（任务号 ${b}）`,
          `已保存：out/音乐二.mp3（任务号 ${b}）`,
          `已保存：out/音乐二.mp3（任务号 ${b}）`,
        ].join('\n'),
      ),
    ).toEqual([
      { id: a, state: 'done', files: ['out/音乐一.mp3'] },
      { id: b, state: 'done', files: ['out/音乐二.mp3'] },
    ]);
    expect(jobs('ls out')).toBeUndefined();

    // oasis-tool 没做成：命令退出码不是 0（dsh 照样算调用成功），这一步算没做完，带上出错的那句
    const result = (text: string) =>
      translateNotification(
        ...event('tool/result', {
          message: { toolCallId: 'c', content: [{ type: 'text', text }] },
        }),
      )?.data;
    expect(
      result('[stderr]\noasis-tool 出错：模型服务返回了错误，请稍后再试\n[exit code: 1]'),
    ).toMatchObject({ ok: false, error: '模型服务返回了错误，请稍后再试' });
    // 别的命令退出码不是 0（如 grep 没找到）照旧算做完
    expect(result('[exit code: 1]')).toMatchObject({ ok: true });
    expect(result('[exit code: 1]')).not.toHaveProperty('error');
  });

  it('待办单独成一种事件（不算一步）', () => {
    expect(
      translateNotification(
        ...event('tool/call', {
          callId: 'c',
          name: 'todo_write',
          arguments: JSON.stringify({
            todos: [
              { content: '写分镜', status: 'completed' },
              { content: '生成关键帧', status: 'in_progress' },
              { content: '剪成片', status: 'pending' },
            ],
          }),
        }),
      ),
    ).toEqual({
      kind: 'todos',
      data: {
        items: [
          { text: '写分镜', status: 'done' },
          { text: '生成关键帧', status: 'doing' },
          { text: '剪成片', status: 'pending' },
        ],
      },
    });
  });

  it('过长的内容截断', () => {
    const translated = translateNotification(
      ...event('tool/call', { callId: 'c', name: 'write', arguments: 'x'.repeat(10_000) }),
    );
    expect(String(translated?.data.arguments).length).toBeLessThan(4_100);
  });

  it('模型能力通过文件保留，环境变量不承载整个目录；没有出口代理不装包', () => {
    const packages = {
      egressProxy: undefined,
      npmRegistry: 'https://r/',
      pipIndexUrl: 'https://p/simple',
    };
    const env = sandboxEnv({
      runKey: 'k',
      model: 'deepseek/x',
      place: { modelBaseUrl: 'http://ingress/v1', packages },
    });
    const files = runtimeFiles({
      models: [
        {
          id: 'deepseek/x',
          name: 'DeepSeek',
          contextWindow: 1000000,
          maxTokens: 131072,
          input: ['text', 'image'],
          reasoning: true,
        },
      ],
      sessionId: 'root',
    });
    // 插件默认取最后一档：可以思考的模型最高到 high
    expect(
      JSON.parse(files.find((f) => f.path.endsWith('.oasis-models.json'))!.content.toString()),
    ).toEqual([
      expect.objectContaining({
        maxTokens: 131072,
        contextWindow: 1000000,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, high: 'high' },
      }),
    ]);
    expect(env.OASIS_MODELS).toBeUndefined();
    // dsh 运行命令时会去掉 OASIS_RUN_KEY，oasis-tool 用这一份
    expect(env.OASIS_TOOL_AUTH).toBe('k');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
    // 云端沙箱不设权限档：组合默认就是完全访问
    expect(env.OASIS_PERMISSION).toBeUndefined();
    // 交付目录是绝对路径：在别的目录里跑 oasis-tool，生成的文件也存进 /workspace/out/
    expect(env).toMatchObject({
      OASIS_OUT_DIR: '/workspace/out',
      OASIS_TOOL_STATE_DIR: '/workspace/out/.oasis-tools',
    });
  });

  it('用户电脑上：经网页地址上的 gateway 调模型，平台的文件在项目的 .oasis/ 下，权限档按设置', () => {
    const workplace = {
      kind: 'device',
      deviceId: 'device-0001',
      folder: 'D:\\Projects\\blog',
    } as const;
    const env = sandboxEnv({
      runKey: 'k',
      model: 'deepseek/x',
      place: { workplace, permissions: { mode: 'manual' } },
    });
    expect(env).toMatchObject({
      OASIS_MODEL_BASE_URL: '{origin}/api/run/v1',
      DSH_HOME: '{home}',
      OASIS_IN: '{project}/.oasis/in',
      OASIS_OUT_DIR: '{project}/.oasis/out',
      DSH_PERMISSION_MODE: 'workspace-write',
      OASIS_APPROVAL: 'ask',
    });
    expect(env.HTTPS_PROXY).toBeUndefined();
    // 手动档点过「以后都允许」出文件夹的事：不问了；自动档：完全访问、不问
    expect(permissionEnv(workplace, { mode: 'manual', always: ['command'] })).toEqual({
      DSH_PERMISSION_MODE: 'workspace-write',
      OASIS_APPROVAL: 'allow',
    });
    expect(permissionEnv(workplace, { mode: 'auto' })).toEqual({
      DSH_PERMISSION_MODE: 'danger-full-access',
      OASIS_APPROVAL: 'allow',
    });
  });
});

describe('JSON-RPC 客户端', () => {
  it('请求按 id 配对响应；通知交给回调；错误响应变成 JsonRpcError；连接断开时未完成的请求失败', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const notes: string[] = [];
    const rpc = createJsonRpcClient({ input, output, onNotification: (m) => notes.push(m) });
    output.setEncoding('utf8');
    const sent: { id: number; method: string }[] = [];
    output.on('data', (line: string) =>
      sent.push(
        ...line
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { id: number; method: string }),
      ),
    );

    const ok = rpc.request<{ v: number }>('a');
    const bad = rpc.request('b');
    await new Promise((r) => setImmediate(r));
    input.write('not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: {} })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: sent[1]?.id, error: { code: -32603, message: 'boom' } })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: { v: 1 } })}\n`);
    await expect(ok).resolves.toEqual({ v: 1 });
    await expect(bad).rejects.toBeInstanceOf(JsonRpcError);
    expect(notes).toEqual(['session.status']);

    const hanging = rpc.request('c');
    input.end();
    await expect(hanging).rejects.toThrow(/closed/i);
  });
});

describe('根会话与子代理', () => {
  it('子代理出错不算这一轮失败；根会话这一轮正常结束才算做完', async () => {
    const { connectAgent } = await import('../src/adapter/dsh.ts');
    const input = new PassThrough();
    const output = new PassThrough();
    const observed: unknown[] = [];
    const send = (method: string, params: unknown) =>
      input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    output.on('data', (line: Buffer) => {
      const request = JSON.parse(line.toString());
      if (request.method === 'session/prompt') {
        send('session.event', {
          sessionId: 'root',
          event: {
            type: 'user/message',
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do work' }] },
          },
        });
        send('subagent.started', { parentSessionId: 'root', childSessionId: 'child' });
        send('session.event', {
          sessionId: 'child',
          event: {
            type: 'turn/end',
            data: { reason: { kind: 'error', error: { message: 'child failed' } } },
          },
        });
        send('session.event', {
          sessionId: 'root',
          event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        });
      }
      input.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
    });
    const agent = connectAgent({
      stdin: output,
      stdout: input,
      sessionId: 'root',
      onEvent: (event) => observed.push(event),
    });
    await agent.prompt('do work');
    expect(await agent.waitIdle()).toBeUndefined();
    expect(observed).toContainEqual({
      kind: 'error',
      data: { message: 'child failed', sessionId: 'child', parentSessionId: 'root' },
    });
    agent.abort(new Error('test closed'));
  });
  it('一轮进行中的插话被插进这一轮（不另开一轮）时，这一轮结束就算处理完', async () => {
    const { connectAgent } = await import('../src/adapter/dsh.ts');
    const input = new PassThrough();
    const output = new PassThrough();
    const send = (method: string, params: unknown) =>
      input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    const user = (text: string) =>
      send('session.event', {
        sessionId: 'root',
        event: {
          type: 'user/message',
          data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
        },
      });
    output.on('data', (line: Buffer) => {
      const request = JSON.parse(line.toString());
      input.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
    });
    const agent = connectAgent({
      stdin: output,
      stdout: input,
      sessionId: 'root',
      onEvent: () => {},
    });
    await agent.prompt('do work');
    user('do work');
    await agent.prompt('顺便把标题改短');
    user('顺便把标题改短');
    send('session.event', {
      sessionId: 'root',
      event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    });
    expect(await agent.waitIdle()).toBeUndefined();
    agent.abort(new Error('test closed'));
  });
});
