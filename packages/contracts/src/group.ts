// 群聊：人和 AI 在同一个群里。群里每个 AI 有一个席位（挂在群下面的一条会话，和私聊是同一种东西：
// 自己的会话和工作目录、同一时间只有一轮）。群消息和私聊消息是同一个形状（MessageBody），
// 多了序号、作者和 @ 了谁。两个好友的私聊（kind = 'direct'，见 social.ts）也是这个形状：两个人、没有 AI。
import { z } from 'zod';
import { MAX_ATTACHMENTS, Mention, MessageBody } from './conversation.ts';

export const GROUP_HISTORY_NOTICE = '加入后可查看本群全部历史消息。';
const name = z.string().trim().min(1).max(40);
const AiKey = z.string().min(1).max(50);

/** 群的光：每个群一种，进群整屏换光 */
export const GroupLight = z.enum(['coral', 'mint', 'sky', 'honey']);
export type GroupLight = z.infer<typeof GroupLight>;
/** 没人被 @ 的时候 AI 们：只在被 @ 时说话 / 看情况 / 积极参与 */
export const GroupSpeak = z.enum(['mention', 'auto', 'active']);
export type GroupSpeak = z.infer<typeof GroupSpeak>;
export const GroupOptions = z.object({
  light: GroupLight.default('coral'),
  speak: GroupSpeak.default('mention'),
});
export type GroupOptions = z.infer<typeof GroupOptions>;

/** 一个群里最多几个 AI */
export const MAX_GROUP_AIS = 8;

export const CreateGroupBody = z.object({
  title: name,
  /** 叫进群的 AI（对话 AI 的 key） */
  ais: z.array(AiKey).max(MAX_GROUP_AIS).default([]),
  /** 一起拉进群的好友（用户 ID）；只能拉自己的好友，不用对方同意 */
  members: z.array(z.uuid()).max(100).default([]),
  ...GroupOptions.shape,
});
/** 群主改群的设置：只改给的那几项 */
export const GroupOptionsPatch = GroupOptions.partial();
/** 群主把一个好友拉进群 */
export const AddGroupMemberBody = z.object({ userId: z.uuid() });
/** 改自己在这个群里的昵称；空的就是不设（显示账号的名字） */
export const GroupNicknameBody = z.object({ nickname: z.string().trim().max(40) });
/** 一句话最多引用几个群文件 */
export const MAX_FILE_REFS = 10;
/** 群文件的路径：AI 交的是它 out/ 里的相对路径，人传的是文件名 */
const FilePath = z.string().min(1).max(500);
export const GroupSendBody = z
  .object({
    /** 说的话；带了文件或引用了群文件时可以不写 */
    content: z.string().trim().max(4000),
    requestId: z.uuid(),
    /** @ 了谁：某个 AI、全体 AI、某个人。被 @ 的 AI 各开一轮 */
    mentions: z.array(Mention).max(20).default([]),
    /** 随这句话发的文件（先传到 canvas 的文件 id）；在群里它们同时进群文件 */
    attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
    /** 引用的群文件（路径）；只有群里能用 */
    refs: z.array(FilePath).max(MAX_FILE_REFS).default([]),
    /** 作为任务发到群里：没 @ 某个 AI 时，挑最对口的一个出来负责；只有群里能用 */
    task: z.boolean().default(false),
  })
  .refine(
    (body) => body.content || body.attachments.length || body.refs.length,
    '说点什么，或者带上文件',
  );

/** 群文件是谁做的、谁传的：AI（它的 key）或人（用户 ID） */
export const FileAuthor = z.object({ kind: z.enum(['ai', 'user']), id: z.string() });
export type FileAuthor = z.infer<typeof FileAuthor>;
/**
 * 群文件：AI 交的和人传的。同一个路径只有一份：再交、再传同一个路径就是新版本，旧的不留。
 * AI 开一轮时，别人交的新文件和新版本会拷进它的工作目录（见《群聊》§4）。
 */
export const GroupFile = z.object({
  id: z.uuid(),
  path: FilePath,
  /** 文件名（不含目录） */
  name: z.string(),
  size: z.number().int().nonnegative(),
  /** 最早是谁做的、谁传的 */
  madeBy: FileAuthor,
  /** 现在这一版是谁交的；和 madeBy 不是同一个就是别人改过 */
  changedBy: FileAuthor,
  /** 现在这一版是 AI 的哪一轮交的（人传的没有）；那一轮还在进行就是它正在改 */
  runId: z.uuid().nullable(),
  /** AI 交的这一版在画布里是哪个成果：只给它在画布里的主人（群主），「在画布里打开」用 */
  artifactId: z.uuid().optional(),
  updatedAt: z.iso.datetime(),
});
export type GroupFile = z.infer<typeof GroupFile>;
export const GroupFileList = z.object({ files: z.array(GroupFile) });
export const GroupMember = z.object({
  userId: z.uuid(),
  /** 在这个群里叫什么：设了群昵称是群昵称，没设是账号的名字 */
  displayName: name,
  /** 群昵称，没设为空 */
  nickname: z.string().default(''),
  /** 头像换过几次，0 是没有头像（见 identity 的 PublicProfile） */
  avatarVersion: z.number().int().nonnegative().default(0),
  joinedAt: z.iso.datetime(),
});
export type GroupMember = z.infer<typeof GroupMember>;
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
const AssignItemId = z.string().trim().min(1).max(20);
/**
 * 人改一份没关上的分工单（《群聊》§6）：改派（换一个 AI 做）、改要求、撤掉一项——正在做的一项会先停下
 * 那个 AI 的这一轮；或者整份全部停下。
 */
export const AssignEditBody = z.discriminatedUnion('op', [
  z.object({ op: z.literal('reassign'), item: AssignItemId, key: AiKey }),
  z.object({
    op: z.literal('retask'),
    item: AssignItemId,
    task: z.string().trim().min(1).max(2000),
  }),
  z.object({ op: z.literal('drop'), item: AssignItemId }),
  z.object({ op: z.literal('close') }),
]);
export type AssignEditBody = z.infer<typeof AssignEditBody>;

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
  /** 群，或两个好友的私聊（没有 AI、没有群主能做的那些事） */
  kind: z.enum(['group', 'direct']).default('group'),
  members: z.array(GroupMember),
  ais: z.array(GroupAi),
  options: GroupOptions,
  /** 游标之后的新消息（不带游标时是最近的一页） */
  messages: z.array(GroupMessage),
  /** 还在变的消息（AI 正在写的话、进行中的任务卡、等 AI 忙完的话）和刚变完的：原地换新 */
  live: z.array(GroupMessage).default([]),
  /** 上次还在变、现在已经不在了的消息（AI 什么都没写的空消息会被去掉） */
  gone: z.array(z.uuid()).default([]),
  /** 群文件变过几次的记号：变了就重新读群文件（GET …/files） */
  filesRev: z.number().int().nonnegative().safe().default(0),
  historyNotice: z.literal(GROUP_HISTORY_NOTICE),
});
export type GroupSnapshot = z.infer<typeof GroupSnapshot>;
/**
 * 工作台「任务」页签要的消息：群里最近动过手（有步骤）或在等人回答的那些轮里 AI 的话，和它们的任务卡。
 * 聊天里不放干活的过程，过程在这里看。
 */
export const GroupWork = z.object({ messages: z.array(GroupMessage) });
export const GroupStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: GroupSnapshot }),
  z.object({ type: z.literal('removed') }),
]);
