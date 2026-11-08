// 回归场景（docs/engineering/回归测试.md）：每个场景 = 假供应商的脚本（任务单、方案、每个节点怎么做）
// + 用户怎么操作 + 断言。场景名就是用户原话里的标记 [[e2e:名字]]。各场景按类分在 scenarios/ 下。
import { fault, gateway, takeover } from './scenarios/faults.mjs';
import { groups } from './scenarios/groups.mjs';
import { media, video } from './scenarios/media.mjs';
import { revise, stop, workspace } from './scenarios/revise.mjs';
import { toolnode } from './scenarios/tools.mjs';
import { manifest, testplan, web } from './scenarios/web.mjs';

export { PAGE_TEST } from './scenarios/web.mjs';

export const SCENARIOS = {
  web,
  testplan,
  manifest,
  media,
  revise,
  stop,
  workspace,
  video,
  fault,
  takeover,
  gateway,
  toolnode,
  ...groups,
};
