import type { DashboardData } from '@oasis/contracts/canvas';
import { useEffect, useRef, useState } from 'react';

/** 只将已校验的数据映射到固定图表选项，不执行文件里的脚本或 formatter。 */
export function Dashboard({ data }: { data: DashboardData }) {
  const [index, setIndex] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const selected = data.charts[index] ?? data.charts[0]!;
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import('./chart.ts')
      .then((echarts) => {
        if (disposed || !host.current) return;
        const chart = echarts.init(host.current, undefined, { renderer: 'svg' });
        const style = getComputedStyle(host.current);
        const ink = style.color;
        const tokenColor = (name: string) => {
          const probe = document.createElement('span');
          probe.style.cssText = `display:none;color:var(${name})`;
          host.current!.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        const muted = tokenColor('--oasis-ink-muted');
        const hairline = tokenColor('--oasis-hairline');
        const glass = tokenColor('--oasis-glass-active');
        const axisStyle = {
          axisLine: { lineStyle: { color: hairline } },
          axisTick: { lineStyle: { color: hairline } },
          axisLabel: { color: muted },
          splitLine: { lineStyle: { color: hairline } },
        };
        chart.setOption({
          animation: false,
          color: ['--oasis-accent', '--oasis-ink', '--oasis-ink-muted'].map(tokenColor),
          textStyle: { color: ink, fontFamily: style.fontFamily },
          tooltip: {
            trigger: selected.type === 'pie' ? 'item' : 'axis',
            renderMode: 'richText',
            backgroundColor: glass,
            borderColor: hairline,
            borderRadius: parseFloat(style.getPropertyValue('--oasis-radius-item')),
            shadowBlur: 0,
            textStyle: { color: ink, fontFamily: style.fontFamily },
          },
          legend: { textStyle: { color: ink }, inactiveColor: muted },
          ...(selected.type === 'pie'
            ? {}
            : {
                xAxis: { ...axisStyle, type: 'category', data: selected.labels },
                yAxis: { ...axisStyle, type: 'value' },
                grid: { left: 60, right: 30, top: 50, bottom: 60 },
              }),
          series: selected.series.map((series) =>
            selected.type === 'pie'
              ? {
                  name: series.name,
                  type: 'pie',
                  radius: '60%',
                  data: series.values.map((value, i) => ({ name: selected.labels[i], value })),
                }
              : { name: series.name, type: selected.type, data: series.values },
          ),
        });
        const observer = new ResizeObserver(() => chart.resize());
        observer.observe(host.current);
        cleanup = () => {
          observer.disconnect();
          chart.dispose();
        };
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [selected]);
  return (
    <section className="border-b border-hairline px-6 py-5" aria-label="交互看板">
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="m-0 flex-1 text-lg font-medium">{data.title}</h2>
        <label className="text-sm">
          切换图表{' '}
          <select
            aria-label="切换图表"
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            className="rounded-item border border-hairline bg-glass-active px-3 py-2 text-ink"
          >
            {data.charts.map((c, i) => (
              <option key={i} value={i}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {failed ? (
        <p className="text-sm text-accent">图表没能打开，请查看下方数据。</p>
      ) : (
        <div
          ref={host}
          role="img"
          aria-label={selected.title}
          className="h-[360px] w-full text-ink"
        />
      )}
      <details className="text-sm text-ink-muted">
        <summary>查看图表数据</summary>
        <table className="mt-3 w-full text-left">
          <thead>
            <tr>
              <th>项目</th>
              {selected.series.map((s, i) => (
                <th key={i}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selected.labels.map((label, i) => (
              <tr key={i}>
                <th>{label}</th>
                {selected.series.map((s, n) => (
                  <td key={n}>{s.values[i]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
