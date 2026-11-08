// 工具目录（ADR 0006）：每个工具 = 参数校验 + 目录信息 + 怎么调供应商、怎么算钱，按家族放在 tools/ 下。
// 目录放在 model-gateway（和供应商适配在一起）；以后接新供应商（如 fal.ai）只在 tools/ 里加。
import { music, speech, transcribe } from './tools/audio.ts';
import { androidTest, appCheck, websiteTest } from './tools/checks.ts';
import { decide } from './tools/decide.ts';
import { imageGenerate, imageInspect } from './tools/images.ts';
import type { ToolDef } from './tools/kit.ts';
import { generate3d, render3d } from './tools/three-d.ts';
import { videoGenerate } from './tools/video.ts';
import { webFetch, webSearch } from './tools/web.ts';

/** 目录顺序就是 oasis-tool list 和工具目录里的顺序 */
export const TOOLS: ToolDef[] = [
  websiteTest,
  appCheck,
  androidTest,
  render3d,
  generate3d,
  imageGenerate,
  imageInspect,
  speech,
  transcribe,
  webSearch,
  webFetch,
  music,
  videoGenerate,
  decide,
];

export type { ToolConfig, ToolDef } from './tools/kit.ts';
