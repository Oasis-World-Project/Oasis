// 消息列表贴底：人在底部时，内容长高（新消息、卡片加载完、流式回复）就跟着滚到底；
// 人往上翻看历史时不打扰。
import { useEffect, useRef, type RefObject } from 'react';

/** 离底部这么近就算「在底部」 */
const NEAR_BOTTOM = 80;

export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): () => void {
  const stuck = useRef(true);

  useEffect(() => {
    const box = scroller.current;
    const inner = content.current;
    if (!box || !inner) return;
    const onScroll = () => {
      stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    // jsdom 没有 ResizeObserver；测试里不需要贴底
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (stuck.current) box.scrollTo({ top: box.scrollHeight });
          });
    observer?.observe(inner);
    return () => {
      box.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [scroller, content]);

  /** 自己发消息时无论翻到哪都回到底部 */
  return () => {
    stuck.current = true;
    const box = scroller.current;
    box?.scrollTo({ top: box.scrollHeight });
  };
}
