// 私聊在哪干活、手动还是自动、一轮里要你点的确认卡。
import type { MessageBody, TurnState } from '@oasis/contracts/conversation';
import type { OasisDesktop } from '@oasis/contracts/desktop';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json } from './fake-api.ts';

const NOW = '2026-11-14T08:00:00.000Z';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const CARD = '00000000-0000-4000-8000-0000000000e1';
const BASE = `/conversation/v1/conversations/${CONV}`;
const CLOUD = { workplace: { kind: 'cloud' }, permissions: { mode: 'auto' } };
const DM = {
  id: CONV,
  kind: 'dm',
  title: 'Claude',
  modelKey: 'claude',
  createdAt: NOW,
  lastMessageAt: NOW,
  turn: null,
  ...CLOUD,
};
const DEVICE = { kind: 'device', deviceId: 'desk-0001-abcd', folder: 'D:\\Projects\\blog' };

const text = (role: 'user' | 'assistant', content: string, data: object = {}) =>
  ({
    id: `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`,
    role,
    content,
    status: 'complete',
    error: null,
    createdAt: NOW,
    kind: 'text',
    data,
  }) as MessageBody;

/** 一个私聊的假后端：消息、正在进行的一轮由测试摆好；改设置、点确认卡记下来 */
function fakeChat(messages: MessageBody[], turn: TurnState | null = null) {
  const chat = { messages, turn, dm: { ...DM } as Record<string, unknown> };
  const api = installFakeApi({
    signedIn: true,
    dms: [chat.dm],
    extra: (method, path, body) => {
      if (method === 'GET' && path === '/conversation/v1/dms')
        return json(200, { conversations: [chat.dm] });
      if (method === 'GET' && path === `${BASE}/messages`)
        return json(200, { messages: chat.messages, turn: chat.turn });
      if (method === 'PUT' && path === `${BASE}/setup`) {
        const setup = body as { workplace: { kind: string } };
        const moved = setup.workplace.kind !== (chat.dm.workplace as { kind: string }).kind;
        chat.dm = { ...chat.dm, ...setup };
        const divider = moved
          ? { ...text('user', '换到你的电脑（D:\\Projects\\blog）干活，开了新话题'), kind: 'topic' }
          : null;
        return json(200, { conversation: chat.dm, message: divider });
      }
      if (method === 'POST' && path === `${BASE}/confirmations/${CARD}`) {
        const card = chat.turn!.confirmations[0]!;
        chat.turn = { ...chat.turn!, confirmations: [] };
        return json(200, { ...card, status: 'allowed' });
      }
      return undefined;
    },
  });
  return { chat, api };
}

async function openChat() {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: [`/dms/${CONV}`] }),
  });
  await act(() => router.load());
  render(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { oasisDesktop?: unknown }).oasisDesktop;
});

describe('在哪干活、手动还是自动', () => {
  it('浏览器里：写着云端，点开只是说明，换不了地方，也没有手动自动', async () => {
    fakeChat([text('user', '你好'), text('assistant', '你好！')]);
    await openChat();
    fireEvent.click(await screen.findByRole('button', { name: '云端' }));
    const panel = screen.getByRole('dialog', { name: '这段对话在哪干活' });
    expect(within(panel).getByText(/要在自己电脑上做，用 Oasis 桌面版/)).toBeTruthy();
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '动手前问不问' })).toBeNull();
  });

  it('输入框里的联网搜索开关：默认开着；点一下关掉，存进这段私聊的设置，再点一下打开', async () => {
    const { api } = fakeChat([text('user', '你好'), text('assistant', '你好！')]);
    await openChat();
    const toggle = await screen.findByRole('switch', { name: '联网搜索' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.bodies.findLast((b) => b.path === `${BASE}/setup`)?.body).toEqual({
        workplace: { kind: 'cloud' },
        permissions: { mode: 'auto', web: false },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '联网搜索' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
    fireEvent.click(screen.getByRole('switch', { name: '联网搜索' }));
    await waitFor(() =>
      expect(api.bodies.findLast((b) => b.path === `${BASE}/setup`)?.body).toMatchObject({
        permissions: { web: true },
      }),
    );
  });

  it('桌面版里一段还没说过话的对话：家定在这台电脑上，按对话名建文件夹，默认手动；点「自动」马上存下', async () => {
    const defaultProjectFolder = vi.fn(async () => ({
      deviceId: DEVICE.deviceId,
      folder: 'C:\\Users\\me\\Documents\\Oasis\\Claude',
    }));
    (globalThis as { oasisDesktop?: Partial<OasisDesktop> }).oasisDesktop = {
      defaultProjectFolder,
      chooseProjectFolder: async () => null,
      deviceStatus: async () => ({ deviceId: DEVICE.deviceId, connected: true, problem: null }),
    };
    const { chat, api } = fakeChat([]);
    chat.dm.lastMessageAt = null;
    await openChat();
    expect(await screen.findByRole('button', { name: '我的电脑 · Claude' })).toBeTruthy();
    expect(defaultProjectFolder).toHaveBeenCalledWith('Claude');
    expect(api.bodies.find((b) => b.path === `${BASE}/setup`)?.body).toMatchObject({
      workplace: { kind: 'device', deviceId: DEVICE.deviceId },
      permissions: { mode: 'manual' },
    });
    const modes = screen.getByRole('radiogroup', { name: '动手前问不问' });
    expect(within(modes).getByRole('radio', { name: '手动' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(within(modes).getByRole('radio', { name: '自动' }));
    await waitFor(() =>
      expect(api.bodies.findLast((b) => b.path === `${BASE}/setup`)?.body).toMatchObject({
        permissions: { mode: 'auto' },
      }),
    );
  });

  it('桌面版里说过话的对话：点开能换个文件夹，换了聊天里出现开新话题的分隔', async () => {
    const chooseProjectFolder = vi.fn(async () => ({
      deviceId: DEVICE.deviceId,
      folder: DEVICE.folder,
    }));
    (globalThis as { oasisDesktop?: Partial<OasisDesktop> }).oasisDesktop = {
      chooseProjectFolder,
      defaultProjectFolder: vi.fn(),
      deviceStatus: async () => ({ deviceId: DEVICE.deviceId, connected: true, problem: null }),
    };
    const { api } = fakeChat([text('user', '你好'), text('assistant', '你好！')]);
    await openChat();
    fireEvent.click(await screen.findByRole('button', { name: '云端' }));
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText(/换了会开新话题/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '改到我的电脑上做' }));
    await waitFor(() =>
      expect(api.bodies.find((b) => b.path === `${BASE}/setup`)?.body).toEqual({
        workplace: DEVICE,
        permissions: { mode: 'manual' },
      }),
    );
    const divider = await screen.findByRole('separator');
    expect(divider.textContent).toContain('换到你的电脑（D:\\Projects\\blog）干活，开了新话题');
    fireEvent.click(await screen.findByRole('button', { name: '我的电脑 · blog' }));
    expect(await screen.findByText('这台电脑已连上，可以干活。')).toBeTruthy();
  });
});

describe('确认卡', () => {
  it('AI 要做超出权限的事：输入框上面出卡，写着要做什么和那条命令；点「允许一次」交上去、卡收起', async () => {
    const turn: TurnState = {
      runId: RUN,
      startedAt: NOW,
      confirmations: [
        {
          id: CARD,
          kind: 'command',
          text: '要用「完全访问」权限：把日志写到项目外',
          callId: 'c9',
          status: 'pending',
          createdAt: NOW,
        },
      ],
    };
    const { api } = fakeChat(
      [
        text('user', '把日志挪到 D:\\logs', { runId: RUN }),
        {
          ...text('assistant', '', {
            runId: RUN,
            parts: [
              {
                type: 'step',
                id: 'c9',
                tool: 'bash',
                label: '运行命令：Move-Item logs D:\\logs',
                status: 'running',
              },
            ],
          }),
          status: 'streaming',
        },
      ],
      turn,
    );
    await openChat();
    const cards = await screen.findByRole('group', { name: '等你确认' });
    expect(within(cards).getByText('AI 要做超出权限的事，可以吗？')).toBeTruthy();
    expect(within(cards).getByText('要用「完全访问」权限：把日志写到项目外')).toBeTruthy();
    expect(within(cards).getByText('运行命令：Move-Item logs D:\\logs')).toBeTruthy();
    fireEvent.click(within(cards).getByRole('button', { name: '允许一次' }));
    await waitFor(() =>
      expect(api.bodies.find((b) => b.path === `${BASE}/confirmations/${CARD}`)?.body).toEqual({
        decision: 'once',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: '等你确认' })).toBeNull());
  });
});
