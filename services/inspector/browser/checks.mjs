/* global Buffer, URL */
// page.evaluate 里的函数在浏览器里执行：
/* global document, getComputedStyle, innerWidth, innerHeight, requestAnimationFrame, Image */
// 检查浏览器里的检查动作（ADR 0017、0021）：按测试计划操作页面、画面检查。由 controller.mjs 驱动；
// 判断以「页面安定下来」为准，不按秒数：慢机器上帧慢，等的时间自然更长。
import path from 'node:path';

/**
 * 在浏览器里执行：把截图缩到 320×180，取出现最多的颜色；和它差得明显的像素不到千分之一，就算一整片纯色。
 * 少量文字、细线也能超过这个比例，所以只有真的什么都没画（WebGL 只清了屏、白页、黑页）才算。
 */
async function uniform(jpegBase64) {
  const image = new Image();
  image.src = `data:image/jpeg;base64,${jpegBase64}`;
  await image.decode();
  const width = 320;
  const height = 180;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let mode = 0;
  let most = -1;
  for (const [key, count] of counts)
    if (count > most) {
      most = count;
      mode = key;
    }
  const centre = [(mode >> 8) & 15, (mode >> 4) & 15, mode & 15].map((v) => v * 16 + 8);
  let different = 0;
  for (let i = 0; i < data.length; i += 4)
    if (centre.some((value, channel) => Math.abs(data[i + channel] - value) > 24)) different += 1;
  return {
    blank: different < width * height * 0.001,
    color: `#${centre.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
  };
}

/** 浏览器原始报错只取有用的部分：去掉颜色码和 Playwright 的调用日志 */
export const reasonOf = (error) =>
  (error instanceof Error ? error.message : String(error))
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\nCall log:')[0]
    .trim();

/**
 * 检查动作。target 是被测的页面或框：静态网页（ADR 0021）对着隔离框里的文档，其他种类对着整页；
 * 静态网页重新打开入口后要换成新的框（liveFrame）。
 */
export function createChecks({
  page,
  context,
  kind,
  entry,
  origin,
  send,
  target: first,
  liveFrame,
}) {
  let target = first;
  // 页面加载完成后，连续这么多个动画帧里条件都不满足、DOM 也没有任何变化，才下「未通过」的结论。
  const SETTLED_FRAMES = 30;
  // 有的页面永远安定不下来（游戏的计时、动画文字不停改 DOM）：条件一直不满足时最多等这么多帧就下结论，
  // 不然这一步永远没有结果。仍然按帧不按秒（慢机器帧慢，等得自然更久），和画面检查的 LOOK_FRAMES 是同一种上限。
  const RESTLESS_FRAMES = 600;
  /** 等下一帧，并返回期间 DOM 是否有变化（变化计数由初始化脚本累计） */
  const nextFrame = () =>
    target.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => resolve(globalThis.__oasisMutations ?? 0)),
        ),
    );
  /**
   * 反复检查 probe()，直到它返回 { ok: true }；页面加载完成且连续 SETTLED_FRAMES 帧
   * 结果不变、DOM 不动时，返回最后一次的 { ok: false, why }；页面一直在变、等满 RESTLESS_FRAMES 帧时也一样。
   * waited 说的是等到了哪一种情况，接在 why 前面就是完整的原因。
   */
  async function settle(probe) {
    await target.waitForLoadState('load');
    let quiet = 0;
    let mutations = await nextFrame();
    for (let frames = 1; ; frames += 1) {
      const result = await probe();
      if (result.ok) return result;
      const now = await nextFrame();
      quiet = now === mutations ? quiet + 1 : 0;
      mutations = now;
      if (quiet >= SETTLED_FRAMES) return { ...result, waited: '等到页面安定后' };
      if (frames >= RESTLESS_FRAMES)
        return { ...result, waited: `页面一直在变化，等了 ${RESTLESS_FRAMES} 帧后` };
    }
  }
  /** 说清楚一个选择器现在匹配到了什么：几个、第一个的尺寸和样式、文字 */
  async function describe(selector) {
    return target.evaluate((query) => {
      let nodes;
      try {
        nodes = [...document.querySelectorAll(query)];
      } catch {
        return { count: 0, invalid: true };
      }
      const first = nodes[0];
      if (!first) return { count: 0 };
      const box = first.getBoundingClientRect();
      const style = getComputedStyle(first);
      return {
        count: nodes.length,
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.top),
        left: Math.round(box.left),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        disabled: Boolean(first.disabled),
        text: (first.textContent ?? '').trim().slice(0, 200),
      };
    }, selector);
  }
  const shape = (d) =>
    d.invalid
      ? '选择器写法不被浏览器接受'
      : d.count === 0
        ? '页面上没有匹配的元素'
        : `匹配 ${d.count} 个；第一个 ${d.width}×${d.height}px，位置 (${d.left}, ${d.top})，display=${d.display}，visibility=${d.visibility}，opacity=${d.opacity}${d.disabled ? '，已禁用' : ''}${d.text ? `，文字「${d.text}」` : ''}`;
  /** 元素中心点上实际接收点击的是谁（被遮挡时说出挡住它的元素） */
  async function hitTarget(selector) {
    return target.evaluate((query) => {
      const target = document.querySelector(query);
      if (!target) return { ok: false, why: '页面上没有匹配的元素' };
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return { ok: false, why: '元素尺寸为 0' };
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
        return {
          ok: false,
          why: `元素中心 (${Math.round(x)}, ${Math.round(y)}) 在 ${innerWidth}×${innerHeight} 的窗口外`,
        };
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === target || target.contains(hit))) return { ok: true };
      const name = (el) =>
        el
          ? `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-testid') ? ` data-testid="${el.getAttribute('data-testid')}"` : ''}${typeof el.className === 'string' && el.className ? ` class="${el.className.slice(0, 80)}"` : ''}>`
          : '空白';
      return { ok: false, why: `中心点被 ${name(hit)} 挡住` };
    }, selector);
  }

  /**
   * 按键只到拿着键盘焦点的那个文档。静态网页在隔离框里，还没点过页面时焦点在外壳上；body 这类元素又聚不了焦，
   * 这时对着它按键，被测页面一个键盘事件都收不到（游戏菜单里「按 1 选关」就是这样没反应的）。
   * 按键前先把焦点交给框，相当于用户已经点进了画布里的作品；焦点已经在框里就不动它。
   */
  async function focusApp() {
    if (kind !== 'static' || (await target.evaluate(() => document.hasFocus()))) return;
    await page.locator('iframe[title="oasis-live"]').focus();
  }

  /** 一步测试：没通过时抛出说清原因的错误 */
  async function perform(step) {
    const locator = step.selector ? target.locator(step.selector).first() : undefined;
    /** 等元素可见；要操作它时还要等它可用 */
    const ready = async (usable = true) => {
      const checked = await settle(async () => {
        const d = await describe(step.selector);
        // Playwright 专有写法（如 text=）浏览器认不出，按 Playwright 的可见/可用判断
        if (d.invalid)
          return (await locator.isVisible()) && (!usable || (await locator.isEnabled()))
            ? { ok: true }
            : { ok: false, why: '仍不可见或不可用' };
        if (!(d.count > 0 && d.width > 0 && d.height > 0 && d.visibility !== 'hidden'))
          return { ok: false, why: `仍不可见：${shape(d)}` };
        if (usable && d.disabled) return { ok: false, why: `仍是禁用状态：${shape(d)}` };
        return { ok: true };
      });
      if (!checked.ok) throw new Error(`${checked.waited}${checked.why}`);
    };
    switch (step.action) {
      case 'navigate': {
        const url = new URL(step.path, origin);
        if (url.origin !== origin) throw new Error('导航超出测试目标');
        // 画布里只运行入口页面（ADR 0021）：静态网页只能重新打开入口
        if (kind === 'static' && !['/', `/${path.basename(entry)}`].includes(url.pathname))
          throw new Error('画布里只运行入口页面，不能打开别的页面；多页内容请做成同一页里的切换');
        // 入口页面是放进隔离框里运行的，地址上的查询参数和 # 片段到不了页面：悄悄丢掉的话，
        // 靠它打开的功能（如 ?debug=1 的调试按钮）不会出现，后面的步骤只会莫名其妙地找不到元素
        if (kind === 'static' && (url.search || url.hash))
          throw new Error(
            `画布里打开入口页面时不带查询参数和 # 片段，页面读不到 ${url.search}${url.hash}`,
          );
        const response = await page.goto(kind === 'static' ? origin : url.href, {
          waitUntil: 'domcontentloaded',
        });
        if (!response) throw new Error('页面没有响应');
        if (response.status() >= 400) throw new Error(`页面返回 ${response.status()}`);
        if (kind === 'static') target = await liveFrame();
        return;
      }
      case 'click': {
        await ready();
        if (!(await describe(step.selector)).invalid) {
          const hit = await settle(() => hitTarget(step.selector));
          if (!hit.ok) throw new Error(`${hit.waited}仍点不到：${hit.why}`);
        }
        await locator.click();
        return;
      }
      case 'fill':
        await ready();
        await locator.fill(step.text);
        return;
      case 'press':
        await ready();
        await focusApp();
        await locator.press(step.key);
        return;
      case 'visible':
        await ready(false);
        return;
      case 'text':
      case 'count': {
        const checked = await settle(async () => {
          if (step.action === 'count') {
            const count = await target.locator(step.selector).count();
            return count === step.count
              ? { ok: true }
              : { ok: false, why: `匹配 ${count} 个，要求 ${step.count} 个` };
          }
          const texts = await target.locator(step.selector).allTextContents();
          return texts.some((text) => text.includes(step.text))
            ? { ok: true }
            : {
                ok: false,
                why: texts.length
                  ? `文字不含「${step.text}」，实际为「${texts.join(' | ').slice(0, 300)}」`
                  : '仍没有匹配的元素',
              };
        });
        if (!checked.ok) throw new Error(`${checked.waited}${checked.why}`);
        return;
      }
      case 'screenshot':
        return;
      default:
        throw new Error('不支持的测试步骤');
    }
  }

  /** 按测试计划操作；前面一步没过，后面的记为没检查到。每步截图经控制协议送出 */
  async function test(plan) {
    const report = {
      version: 1,
      target: kind === 'website' ? 'website' : 'application',
      passed: true,
      steps: [],
      diagnostics: [],
      unchecked: [],
    };
    for (const [index, step] of plan.steps.entries()) {
      const result = { index, action: step.action, status: 'passed' };
      report.steps.push(result);
      if (!report.passed) {
        result.status = 'unchecked';
        continue;
      }
      const label = `第 ${index + 1} 步 ${step.action}${step.selector ? ` ${step.selector}` : step.path ? ` ${step.path}` : ''}`;
      try {
        await perform(step);
      } catch (error) {
        result.status = 'failed';
        result.error = `${label}：${reasonOf(error)}`;
        report.passed = false;
      }
      if (step.action === 'screenshot' || result.status === 'failed') {
        try {
          const bytes = await page.screenshot({ type: 'jpeg', quality: 45 });
          result.screenshot = `step-${index}.jpg`;
          send({
            kind: 'test-screenshot',
            name: result.screenshot,
            base64: Buffer.from(bytes).toString('base64'),
          });
        } catch (error) {
          report.unchecked.push(`第 ${index + 1} 步截图未取得：${reasonOf(error)}`);
        }
      }
    }
    if (!plan.steps.some((step) => ['visible', 'text', 'count'].includes(step.action)))
      report.unchecked.push('没有业务断言，仅验证操作可执行');
    send({ kind: 'test-result', report });
  }

  /**
   * 画面检查（ADR 0021）：页面加载完后每隔一段动画帧截一次图，只要不是一整片纯色就算画出来了；
   * 一直是纯色时，最多等 LOOK_FRAMES 帧再下结论。截图在一个空白页里解码统计，不碰被测页面。
   */
  const LOOK_FRAMES = 300;
  async function look() {
    await target.waitForLoadState('load');
    const helper = await context.newPage();
    try {
      let result = { blank: true };
      for (let waited = 0; ; waited += 30) {
        const shot = await page.screenshot({ type: 'jpeg', quality: 80 });
        result = await helper.evaluate(uniform, Buffer.from(shot).toString('base64'));
        if (!result.blank || waited >= LOOK_FRAMES) return result;
        for (let i = 0; i < 30; i++) await nextFrame();
      }
    } finally {
      await helper.close();
    }
  }

  return { test, look };
}
