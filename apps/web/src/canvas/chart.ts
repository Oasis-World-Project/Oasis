// 只打包受控预览用到的三种图表和 SVG 渲染器。
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use as registerCharts } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

registerCharts([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  SVGRenderer,
]);
export { init };
