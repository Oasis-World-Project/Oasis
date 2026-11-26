// 聊天页的数据（群、和好友的私聊、和 AI 的私聊是同一套）：连着推送（成员、AI、消息），发消息，各种操作。
// AI 的消息是原地更新的（序号不变）：推送里的 live 是还在变的和刚变完的，按 id 换新；gone 是不在了的。
// 和 AI 的私聊只有读和推送走群的接口，发话走私聊自己的接口（它不回房间的样子，发完重新读一遍）。
import type { Mention } from '@oasis/contracts/conversation';
import { GroupStreamEvent, inFlux, type GroupSnapshot } from '@oasis/contracts/group';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { groupSnapshot, sendGroupMessage, sendMessage } from '../api/queries.ts';
import type { SendFiles } from './room.ts';

/** 推送连接彻底关了（EventSource.CLOSED）：浏览器不会再自己重连 */
const CLOSED = 2;

/** 新来的一份并进手上的：消息按 id 换新、按序号排，不在了的去掉 */
function mergeSnapshot(previous: GroupSnapshot | null, next: GroupSnapshot): GroupSnapshot {
  const messages = new Map(previous?.messages.map((message) => [message.id, message]));
  for (const message of [...next.messages, ...next.live]) messages.set(message.id, message);
  for (const id of next.gone) messages.delete(id);
  return {
    ...next,
    live: [],
    gone: [],
    messages: [...messages.values()].sort((a, b) => a.seq - b.seq),
  };
}

/**
 * 手上还在变、这一份推送里却没有的消息：连接断过，中间它变完了。重新读最近一页对一下；
 * 读回来的里面也没有的，就是已经不在了。
 */
function reconcile(current: GroupSnapshot, fetched: GroupSnapshot): GroupSnapshot {
  const fresh = new Set([...fetched.messages, ...fetched.live].map((message) => message.id));
  const merged = mergeSnapshot(current, fetched);
  return {
    ...merged,
    messages: merged.messages.filter((message) => !inFlux(message) || fresh.has(message.id)),
  };
}

/** gone：这个群（或这个私聊）不在了时写在页面上的话 */
export function useGroupRoom(id: string, gone = '这个群已解散，或你已不在群里。') {
  const [group, setGroup] = useState<GroupSnapshot | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState(true);
  const revoked = useRef(false);
  const pending = useRef<{ draft: string; id: string } | null>(null);
  const checking = useRef(false);
  const latest = useRef<GroupSnapshot | null>(null);
  const client = useQueryClient();
  useEffect(() => {
    latest.current = group;
  }, [group]);

  /** 把一份快照并进来（发消息、改设置等操作返回的） */
  const apply = useCallback((snapshot: GroupSnapshot) => {
    if (!revoked.current) setGroup((previous) => mergeSnapshot(previous, snapshot));
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const remove = () => {
      revoked.current = true;
      setGroup(null);
      setOnline(false);
      setError(gone);
      source?.close();
      void client.invalidateQueries({ queryKey: ['groups'] });
    };
    /** 手上有还在变、这份里没有的消息：读最近一页对一下 */
    const recheck = (snapshot: GroupSnapshot, previous: GroupSnapshot | null) => {
      const fresh = new Set([...snapshot.messages, ...snapshot.live].map((m) => m.id));
      if (checking.current || !previous?.messages.some((m) => inFlux(m) && !fresh.has(m.id)))
        return;
      checking.current = true;
      void groupSnapshot(id)
        .then((fetched) => {
          if (!closed && !revoked.current)
            setGroup((current) => (current ? reconcile(current, fetched) : current));
        })
        .catch(() => undefined)
        .finally(() => {
          checking.current = false;
        });
    };
    const onMessage = (event: MessageEvent<string>) => {
      if (closed || revoked.current) return;
      failures = 0;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        setError('群消息格式不正确，请刷新重试');
        return;
      }
      const value = GroupStreamEvent.safeParse(payload);
      if (!value.success) {
        setError('群消息格式不正确，请刷新重试');
        return;
      }
      if (value.data.type === 'removed') {
        remove();
        return;
      }
      const snapshot = value.data.snapshot;
      recheck(snapshot, latest.current);
      setGroup((previous) => mergeSnapshot(previous, snapshot));
      setOnline(true);
      setError('');
    };
    /** 连上推送；手上已经有消息的，从最后一条之后接着要 */
    const connect = () => {
      const after = latest.current?.messages.at(-1)?.seq;
      const stream = new EventSource(
        `/api/conversation/v1/groups/${id}/events${after ? `?after=${after}` : ''}`,
      );
      source = stream;
      stream.onmessage = onMessage;
      stream.onerror = () => {
        if (closed || revoked.current) return;
        setOnline(false);
        void groupSnapshot(id).catch((err) => {
          if (!closed && err instanceof ApiError && [401, 403, 404].includes(err.status)) remove();
        });
        // 服务端回了错误（比如服务正在重启）时浏览器不会自己再连：隔一会儿重新连，越等越久
        if (stream.readyState !== CLOSED) return;
        failures += 1;
        retry = setTimeout(connect, Math.min(1000 * 2 ** (failures - 1), 10000));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [id, client, gone]);

  /** 重新读最近一页对一下：私聊的写接口（发话、引导、停下、从队里删）做完后用；手上还在变、读回来没有的就是不在了 */
  const refresh = useCallback(async () => {
    const fetched = await groupSnapshot(id);
    if (!revoked.current)
      setGroup((current) => (current ? reconcile(current, fetched) : mergeSnapshot(null, fetched)));
  }, [id]);

  /** 做一件事（改设置、加减 AI、移除成员……）：同一时间只做一件，出错写在页面上；返回做成了没有 */
  const act = useCallback(
    async (work: () => Promise<GroupSnapshot | void>): Promise<boolean> => {
      setBusy(true);
      setError('');
      try {
        const result = await work();
        if (result) apply(result);
        await client.invalidateQueries({ queryKey: ['groups'] });
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失败');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply, client],
  );

  /** 发一句话；没发出去时保留草稿，重试用同一个请求号（不会重复发送）。返回发出去了没有 */
  const send = useCallback(
    async (content: string, mentions: Mention[], files: SendFiles = {}): Promise<boolean> => {
      if (sending || revoked.current) return false;
      setSending(true);
      setError('');
      // 同样的话、同样的文件重发用同一个请求号
      const draft = JSON.stringify([
        content,
        files.attachments ?? [],
        files.refs ?? [],
        files.task,
        files.seat,
      ]);
      if (pending.current?.draft !== draft) pending.current = { draft, id: crypto.randomUUID() };
      try {
        if (latest.current?.kind === 'dm') {
          await sendMessage(id, {
            content,
            attachments: files.attachments ?? [],
            ...(files.task ? { task: true } : {}),
            ...(files.seat ? { seat: files.seat } : {}),
          });
          await refresh();
        } else apply(await sendGroupMessage(id, content, pending.current.id, mentions, files));
        pending.current = null;
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : '发送失败，重试不会重复发送');
        return false;
      } finally {
        setSending(false);
      }
    },
    [apply, id, refresh, sending],
  );

  const loadOlder = useCallback(async () => {
    const first = group?.messages[0];
    if (!first || revoked.current) return;
    setBusy(true);
    try {
      const snapshot = await groupSnapshot(id, first.seq);
      apply({ ...snapshot, live: [], gone: [] });
      if (snapshot.messages.length < 100) setOlder(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史消息加载失败');
    } finally {
      setBusy(false);
    }
  }, [apply, group, id]);

  /** 自己退群、解散群之后：不再理会这个群的推送 */
  const leave = useCallback(() => {
    revoked.current = true;
    setGroup(null);
  }, []);

  return {
    group,
    error,
    online,
    sending,
    busy,
    hasOlder: older && Boolean(group?.messages[0] && group.messages[0].seq > 1),
    apply,
    refresh,
    act,
    send,
    loadOlder,
    leave,
  };
}
