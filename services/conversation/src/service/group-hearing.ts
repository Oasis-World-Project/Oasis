// 群里轮到一个 AI 时交给它什么：群里它没听过的话连成一段（谁说的、几点、@ 了谁），最后写明为什么
// 轮到它；人设后面接上群里有谁、每个 AI 负责什么。
import type { Mention } from '@oasis/contracts/conversation';
import type { handOver } from './hand-over.ts';
import { taskTitle } from './task-title.ts';

/** 拷进工作目录的文件，和接在话后面、告诉 AI 文件在哪的说明 */
type Handed = ReturnType<typeof handOver>;

/** 群里的一轮交给 AI 的东西：那段话、接在人设后面的群说明、任务名、说了叫它的话的人 */
export interface SeatBrief {
  text: string;
  persona: string;
  title: string;
  callers: string[];
  /** 群文件里它还没拿到的（别人新交、新改的）：拷进它的工作目录（group-files.ts） */
  files?: Handed;
  /** 原来的工作目录接不上、这一轮从头开始时：全部群文件 */
  allFiles?: Handed;
}

/** 群里的一句话里 AI 听的那部分 */
export interface Heard {
  seq: number;
  authorKind: 'user' | 'ai';
  /** 用户 ID，或 AI 的 key */
  authorId: string;
  /** 群内名，或 AI 的名字 */
  name: string;
  content: string;
  createdAt: Date;
  mentions: Mention[];
  /** 这句话带的文件、引用的群文件（文件名） */
  files: string[];
  /** 这句是作为任务发到群里的 */
  task?: boolean;
  /** @ 了全体或作为任务发布时，挑中先出来负责的那个 AI */
  lead?: string;
}

/** 群里有谁 */
export interface Roster {
  title: string;
  ownerId: string;
  members: { userId: string; displayName: string }[];
  ais: { key: string; name: string; role: string }[];
}

/** 一次最多交给 AI 多少条、多少字；更早的只告诉它还有几条 */
const MAX_HEARD = 40;
const MAX_CHARS = 12_000;

/** 这句话是对全体 AI 说的：@ 了全体，或作为任务发到群里（没点名某个 AI） */
const toEveryone = (message: Heard) =>
  message.mentions.some((m) => m.kind === 'all') ||
  (message.task === true && !message.mentions.some((m) => m.kind === 'ai'));

/**
 * 这句话是不是在叫这个 AI：@ 了它；或者是对全体 AI 说的、挑中先出来负责的是它
 * （别的 AI 不因为这句话开工，等它说完）
 */
export const calls = (message: Heard, key: string) =>
  message.authorKind === 'user' &&
  (message.mentions.some((m) => m.kind === 'ai' && m.key === key) ||
    (toEveryone(message) && message.lead === key));

const clock = (at: Date) => at.toISOString().slice(5, 16).replace('T', ' ');

function mentionName(mention: Mention, roster: Roster): string {
  if (mention.kind === 'all') return '全体 AI';
  if (mention.kind === 'ai')
    return roster.ais.find((ai) => ai.key === mention.key)?.name ?? mention.key;
  return roster.members.find((m) => m.userId === mention.userId)?.displayName ?? '成员';
}

function line(message: Heard, roster: Roster): string {
  const who =
    message.authorKind === 'ai'
      ? `${message.name}（AI）`
      : message.authorId === roster.ownerId
        ? `${message.name}（群主）`
        : message.name;
  const at = message.mentions.map((m) => `@${mentionName(m, roster)}`).join(' ');
  const files = message.files.length ? `（带了群文件：${message.files.join('、')}）` : '';
  return `[${clock(message.createdAt)}] ${who}${at ? ` ${at}` : ''}：${message.content}${files}`;
}

/** 从最新的往回留，留到条数或字数的上限；返回留下的几行 */
function recent(heard: Heard[], roster: Roster): string[] {
  const lines: string[] = [];
  let size = 0;
  for (const message of heard.slice(-MAX_HEARD).reverse()) {
    const text = line(message, roster);
    if (lines.length && size + text.length > MAX_CHARS) break;
    size += text.length;
    lines.unshift(text);
  }
  return lines;
}

/** 接在人设后面的一节：群名、群里的人、群里的 AI 和各自负责什么 */
function groupPersona(key: string, roster: Roster): string {
  const people = roster.members
    .map((m) => (m.userId === roster.ownerId ? `${m.displayName}（群主）` : m.displayName))
    .join('、');
  const ais = roster.ais
    .map((ai) => {
      const notes = [ai.key === key ? '你' : '', ai.role ? `负责：${ai.role}` : '']
        .filter(Boolean)
        .join('；');
      return notes ? `${ai.name}（${notes}）` : ai.name;
    })
    .join('、');
  return `## 你所在的群\n\n- 群名：${roster.title}\n- 群里的人：${people}\n- 群里的 AI：${ais}`;
}

/** 群里的话连成的一段。skipped：更早还有多少条没取出来；ending：最后一行（为什么轮到它） */
export function hearingText(heard: Heard[], roster: Roster, skipped: number, ending: string) {
  const lines = recent(heard, roster);
  const omitted = skipped + heard.length - lines.length;
  return [
    '群里的新消息（时间是 UTC）：',
    ...(omitted > 0 ? [`（更早还有 ${omitted} 条没列出来）`] : []),
    ...lines,
    '',
    ending,
  ].join('\n');
}

/** 没人叫它、它自己开口时交给它的东西：接群里的话，或者群里安静时起个话头（ending 说明是哪一种） */
export function ownBrief(
  key: string,
  roster: Roster,
  heard: Heard[],
  skipped: number,
  ending: string,
): SeatBrief {
  return {
    text: heard.length ? hearingText(heard, roster, skipped, ending) : ending,
    persona: groupPersona(key, roster),
    title: taskTitle([], heard.at(-1)?.content ?? '群里闲聊'),
    callers: [],
  };
}

/**
 * 轮到这个 AI 时交给它的东西；这些话里没有人叫它就返回 undefined（不开这一轮）。
 * heard：它没听过的话，按先后；skipped：更早还有多少条没取出来。
 */
export function seatBrief(
  key: string,
  roster: Roster,
  heard: Heard[],
  skipped: number,
): SeatBrief | undefined {
  const mine = heard.filter((message) => calls(message, key));
  const last = mine.at(-1);
  if (!last) return undefined;
  const names = [...new Set(mine.map((message) => message.name))].join('、');
  const byName = last.mentions.some((m) => m.kind === 'ai' && m.key === key);
  const how = byName
    ? `@ 了你${last.task ? '，这件事是作为任务发到群里的，由你负责' : ''}`
    : `${last.task ? '把一件事作为任务发到了群里' : '@ 了全体 AI'}，判断下来你最对口，由你先出来负责（别的 AI 在等你说完）`;
  return {
    text: hearingText(heard, roster, skipped, `轮到你了：${names} ${how}。`),
    persona: groupPersona(key, roster),
    title: taskTitle([], last.content),
    callers: [...new Set(mine.map((message) => message.authorId))],
  };
}
