// 回归场景（docs/engineering/回归测试.md）：每个场景 = 假模型按用户每句话怎么做（says）
// + 用户怎么操作 + 断言。用户每句话里带标记 [[e2e:场景@本轮编号/第几句]]。各场景按类分在 scenarios/ 下。
import { device } from './scenarios/device.mjs';
import { fault, gateway, takeover } from './scenarios/faults.mjs';
import { media, video } from './scenarios/media.mjs';
import { interject, revise, stop, topic, workspace } from './scenarios/revise.mjs';
import { chat, solo, web } from './scenarios/web.mjs';

export { PAGE_TEST } from './scenarios/web.mjs';

export const SCENARIOS = {
  chat,
  web,
  solo,
  media,
  revise,
  interject,
  stop,
  topic,
  workspace,
  video,
  device,
  fault,
  takeover,
  gateway,
};
