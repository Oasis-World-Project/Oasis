// 假供应商的生视频型号，以及看图挑一版（ADR 0026 的挑选运行用 image.inspect）时怎么回答。

/** 生视频型号：每秒 $0.05（5 秒 $0.25，和生成完成时报的花费一致） */
export const VIDEO_MODELS = {
  data: ['fake/video-1'].map((id) => ({
    id,
    supported_durations: [4, 5, 6, 8, 10],
    supported_resolutions: ['480p', '720p', '1080p'],
    supported_aspect_ratios: ['16:9', '9:16', '1:1'],
    supported_frame_images: ['first_frame'],
    pricing_skus: { duration_seconds: '0.05' },
  })),
};

/** 看图挑一版：总是挑列出的最后一版，理由写具体差别；不是挑选的请求返回 undefined */
export function pickAnswer(messages, question) {
  const parts = Array.isArray(messages[0]?.content) ? messages[0].content : [];
  if (!parts.some((p) => p?.type && p.type !== 'text') || !question.includes('挑选标准')) return;
  const listed = [...question.matchAll(/第 (\d+) 版/g)].map((m) => Number(m[1]));
  const choice = listed.at(-1) ?? 1;
  return {
    choice,
    images: parts.length - 1,
    reason: `第 ${choice} 版主体更居中、光线更贴近镜头描述（回归测试的假视觉模型）`,
  };
}
