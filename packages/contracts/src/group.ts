import { z } from 'zod';

export const GROUP_HISTORY_NOTICE = '加入后可查看本群全部历史消息。';
const name = z.string().trim().min(1).max(40);
export const CreateGroupBody = z.object({ title: name, displayName: name });
export const InviteToken = z.string().regex(/^[a-f0-9]{64}$/);
export const RedeemGroupBody = z.object({
  token: InviteToken,
  displayName: name,
  acceptHistory: z.literal(true),
});
export const GroupSendBody = z.object({
  content: z.string().trim().min(1).max(4000),
  requestId: z.uuid(),
});
export const GroupMember = z.object({
  userId: z.uuid(),
  displayName: name,
  joinedAt: z.iso.datetime(),
});
export const GroupSummary = z.object({
  id: z.uuid(),
  title: name,
  ownerId: z.uuid(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export const GroupList = z.object({ groups: z.array(GroupSummary) });
export const GroupMessage = z.object({
  id: z.uuid(),
  seq: z.number().int().positive().safe(),
  authorId: z.uuid(),
  displayName: z.string(),
  content: z.string(),
  createdAt: z.iso.datetime(),
});
export type GroupMessage = z.infer<typeof GroupMessage>;
export const GroupSnapshot = GroupSummary.extend({
  members: z.array(GroupMember),
  messages: z.array(GroupMessage),
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
