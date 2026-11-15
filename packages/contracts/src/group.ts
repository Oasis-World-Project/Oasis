// 群聊：人和 AI 在同一个群里。群里每个 AI 有一个席位（挂在群下面的一条会话，和私聊是同一种东西：
// 自己的会话和工作目录、同一时间只有一轮）。群消息和私聊消息是同一个形状（MessageBody），
// 多了序号、作者和 @ 了谁。
import { z } from 'zod';
import { Mention, MessageBody } from './conversation.ts';

export const GROUP_HISTORY_NOTICE = '加入后可查看本群全部历史消息。';
const name = z.string().trim().min(1).max(40);
const AiKey = z.string().min(1).max(50);

/** 群的光：每个群一种，进群整屏换光 */
export const GroupLight = z.enum(['coral', 'mint', 'sky', 'honey']);
export type GroupLight = z.infer<typeof GroupLight>;
/** 没人被 @ 的时候 AI 们：只在被 @ 时说话 / 看情况 / 积极参与 */
export const GroupSpeak = z.enum(['mention', 'auto', 'active']);
export type GroupSpeak = z.infer<typeof GroupSpeak>;
/** 发任务时：AI 们自己商量认领 / 群主来指派 */
export const GroupAssign = z.enum(['ai', 'owner']);
export const GroupOptions = z.object({
  light: GroupLight.default('coral'),
  speak: GroupSpeak.default('mention'),
  assign: GroupAssign.default('ai'),
});
export type GroupOptions = z.infer<typeof GroupOptions>;

/** 一个群里最多几个 AI */
export const MAX_GROUP_AIS = 8;

export const CreateGroupBody = z.object({
  title: name,
  displayName: name,
  /** 叫进群的 AI（对话 AI 的 key） */
  ais: z.array(AiKey).max(MAX_GROUP_AIS).default([]),
  ...GroupOptions.shape,
});
/** 群主改群的设置：只改给的那几项 */
export const GroupOptionsPatch = GroupOptions.partial();
export const InviteToken = z.string().regex(/^[a-f0-9]{64}$/);
export const RedeemGroupBody = z.object({
  token: InviteToken,
  displayName: name,
  acceptHistory: z.literal(true),
});
export const GroupSendBody = z.object({
  content: z.string().trim().min(1).max(4000),
  requestId: z.uuid(),
  /** @ 了谁：某个 AI、全体 AI、某个人。被 @ 的 AI 各开一轮 */
  mentions: z.array(Mention).max(20).default([]),
});
export const GroupMember = z.object({
  userId: z.uuid(),
  displayName: name,
  joinedAt: z.iso.datetime(),
});
/** 群里的一个 AI（席位） */
export const GroupAi = z.object({
  key: AiKey,
  /** 在这个群里负责什么（群主写的，没写为空） */
  role: z.string().max(60),
  /** 它正在进行的一轮；有空时为 null */
  runId: z.uuid().nullable(),
  startedAt: z.iso.datetime().nullable(),
  /** 这一轮是谁的话引来的（用户 ID）：他们和群主能停下它 */
  callers: z.array(z.uuid()),
  /** 它听到群里第几条了：@ 它的话序号比这大，就是它还没看到（在忙，忙完就看） */
  heardSeq: z.number().int().nonnegative().safe(),
});
export type GroupAi = z.infer<typeof GroupAi>;
export const AddGroupAiBody = z.object({ key: AiKey });
export const GroupAiRoleBody = z.object({ role: z.string().trim().max(60) });
/** 「现在告诉它」：排着的一句现在作为插话交给这个 AI 正在做的一轮 */
export const GroupSteerBody = z.object({ key: AiKey });

export const GroupSummary = z.object({
  id: z.uuid(),
  title: name,
  ownerId: z.uuid(),
  memberCount: z.number().int().nonnegative(),
  aiCount: z.number().int().nonnegative(),
  light: GroupLight,
  createdAt: z.iso.datetime(),
});
export type GroupSummary = z.infer<typeof GroupSummary>;
export const GroupList = z.object({ groups: z.array(GroupSummary) });

/** 群里的一条消息：私聊消息的形状，加上序号和是谁发的（人是用户 ID 和群内名，AI 是它的 key） */
export const GroupMessage = MessageBody.and(
  z.object({
    seq: z.number().int().positive().safe(),
    authorId: z.string(),
    displayName: z.string(),
  }),
);
export type GroupMessage = z.infer<typeof GroupMessage>;
export const GroupSnapshot = GroupSummary.extend({
  members: z.array(GroupMember),
  ais: z.array(GroupAi),
  options: GroupOptions,
  /** 游标之后的新消息（不带游标时是最近的一页） */
  messages: z.array(GroupMessage),
  /** 还在变的消息（AI 正在写的话、进行中的任务卡、等 AI 忙完的话）和刚变完的：原地换新 */
  live: z.array(GroupMessage).default([]),
  /** 上次还在变、现在已经不在了的消息（AI 什么都没写的空消息会被去掉） */
  gone: z.array(z.uuid()).default([]),
  historyNotice: z.literal(GROUP_HISTORY_NOTICE),
});
export type GroupSnapshot = z.infer<typeof GroupSnapshot>;
export const GroupInvite = z.object({ token: InviteToken, expiresAt: z.iso.datetime() });
export const GroupInvitePreview = z.object({
  title: name,
  historyNotice: z.literal(GROUP_HISTORY_NOTICE),
});
export const GroupStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: GroupSnapshot }),
  z.object({ type: z.literal('removed') }),
]);
