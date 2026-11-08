// 检查容器的收尾（ADR 0024）：解码和浏览器检查的容器都设了用完自动删除，浏览器的控制端在 inspector 断开时
// 自己退出；只有 inspector 在「建好容器、还没启动」之间意外退出时，容器会一直停在已创建状态、不会被自动删。
// 定时清掉放了很久的这种容器（不碰正在用的：检查从建容器到启动只要几秒）。
import type { DockerApi, Logger } from '@oasis/service-kit';

const COMPONENTS = ['inspector-browser', 'inspector-media'];
const STALE_MS = 10 * 60_000;

export function sweepLeftovers(docker: DockerApi, logger: Logger, everyMs = 10 * 60_000) {
  const sweep = async () => {
    for (const component of COMPONENTS)
      for (const container of await docker.listContainers(`oasis.component=${component}`))
        if (
          container.State === 'created' &&
          Date.now() - (container.Created ?? 0) * 1000 > STALE_MS
        )
          await docker.removeContainer(container.Id);
  };
  const run = () =>
    void sweep().catch((err: unknown) =>
      logger.warn({ err }, '清理遗留的检查容器没做完，下次再试'),
    );
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
