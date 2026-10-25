import { zipSync } from 'fflate';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { defaultInspectionLimits, inspectFiles } from '../src/service/file-inspection.ts';

const file = (path: string, content: string | Uint8Array) => ({
  path,
  content: Buffer.from(content),
});
const office = (path: string, parts: Record<string, string>) =>
  file(
    path,
    zipSync(
      Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, Buffer.from(value)])),
    ),
  );
const word = (text: string) =>
  office('报告.docx', {
    'word/document.xml': `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
const inspect = (files: ReturnType<typeof file>[], limits = {}) =>
  inspectFiles(files, 8000, { ...defaultInspectionLimits, ...limits });

function pdf(pages: number): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 12 Tf 20 100 Td (Revenue ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    );
  }
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(source));
    source += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

describe('隔离文件解析', () => {
  it('HTML 内嵌库不耗正文额度，保留可见文字、来源和受校验看板数据', async () => {
    const chart = {
      title: '看板',
      charts: [
        {
          title: '月销售',
          type: 'bar',
          labels: ['一月'],
          series: [{ name: '金额', values: [123] }],
        },
      ],
    };
    const source =
      '<style>body{color:red}</style><script>' +
      'x'.repeat(100000) +
      '</script><h1>运营报告</h1><a href="https://example.com/source">来源一</a><script id="oasis-dashboard" type="application/json">' +
      JSON.stringify(chart) +
      '</script>';
    const result = await inspectFiles([file('看板.html', source)], 2000);
    expect(result.truncated).toBe(false);
    expect(result.files[0]?.text).toContain('运营报告');
    expect(result.files[0]?.text).toContain('https://example.com/source');
    expect(result.files[0]?.text).toContain('123');
    expect(result.files[0]?.text).not.toContain('color:red');
    expect(
      (
        await inspectFiles(
          [
            file(
              '坏图表.html',
              '<p>报告</p><script id="oasis-dashboard" type="application/json">{}</script>',
            ),
          ],
          1000,
        )
      ).files[0]?.warning,
    ).toContain('看板数据无效');
  });
  it('中文 Word 段落和表格、PPT 幻灯片按序提取', async () => {
    const ppt = office('汇报.pptx', {
      'ppt/slides/slide2.xml':
        '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第二张</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml':
        '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>销售总结</a:t></a:r></a:p></p:sld>',
    });
    const result = await inspect([word('中文报告'), ppt]);
    expect(result.files.map((f) => f.valid)).toEqual([true, true]);
    expect(result.files[0]?.text).toContain('中文报告');
    expect(result.files[1]?.text).toMatch(/幻灯片 1.*\n销售总结[\s\S]*幻灯片 2.*\n第二张/);
  });

  it('Excel 按工作表和单元格读取共享字符串、公式与缓存；缺少缓存明确提醒', async () => {
    const book = office('数据.xlsx', {
      'xl/workbook.xml':
        '<workbook xmlns:r="r"><sheets><sheet name="收入" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>销售额</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(B2:B3)</f><v>30</v></c><c r="C1"><f>1+2</f></c></row></sheetData></worksheet>',
    });
    const result = (await inspect([book])).files[0]!;
    expect(result).toMatchObject({ valid: true, warning: expect.stringContaining('缓存缺失') });
    expect(result.text).toContain('工作表：收入');
    expect(result.text).toContain('A1：销售额');
    expect(result.text).toContain('B1：公式 =SUM(B2:B3)；缓存值 30');
    expect((await inspect([book], { cells: 2 })).files[0]).toMatchObject({
      valid: false,
      error: expect.stringContaining('单元格'),
    });
  });
  it('PPT 按演示文稿关系顺序提取，不能按部件文件名推断页序', async () => {
    const input = office('换序.pptx', {
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="b" id="257"/><p:sldId id="256" r:id="a"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<sld><p><t>后页</t></p></sld>',
      'ppt/slides/slide2.xml': '<sld><p><t>首页</t></p></sld>',
    });
    expect((await inspect([input])).files[0]?.text).toMatch(
      /幻灯片 1.*\n首页[\s\S]*幻灯片 2.*\n后页/,
    );
  });

  it('PDF 保留页码，页数超限和损坏文件单独报错', async () => {
    const input = file('报告.pdf', pdf(2));
    const result = await inspect([input, file('坏.pdf', 'not a pdf')]);
    expect(result.files[0]).toMatchObject({
      valid: true,
      text: expect.stringContaining('【第 2 页】\nRevenue 2'),
    });
    expect(result.files[1]?.valid).toBe(false);
    expect((await inspect([input], { pages: 1 })).files[0]?.error).toContain('页数');
  });

  it('图片必须完整解码，返回尺寸，拒绝伪装与像素超限', async () => {
    const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const result = await inspect([
      file('图.png', bytes),
      file('假.png', bytes.subarray(0, 32)),
      file('错.jpg', bytes),
    ]);
    expect(result.files[0]).toMatchObject({ valid: true, width: 8, height: 6, text: '' });
    expect(result.files.slice(1).every((f) => f.valid === false)).toBe(true);
    expect((await inspect([file('图.png', bytes)], { pixels: 10 })).files[0]?.valid).toBe(false);
  });

  it('坏 ZIP、XML 实体、输入及解压体积超限不影响其他文件', async () => {
    const entity = office('实体.docx', {
      'word/document.xml': '<!DOCTYPE a [<!ENTITY x "boom">]><document>&x;</document>',
    });
    const result = await inspect([file('坏.docx', 'bad zip'), entity, file('好.md', '可继续检查')]);
    expect(result.files.slice(0, 2).every((f) => f.valid === false)).toBe(true);
    expect(result.files[2]).toMatchObject({ valid: true, text: '可继续检查' });
    expect(
      (await inspect([word('长'.repeat(1000))], { unzipBytes: 200 })).files[0]?.error,
    ).toContain('解压体积');
    expect(
      (await inspect([file('大.txt', '123456789')], { inputBytes: 8 })).files[0]?.error,
    ).toContain('大小上限');
  });

  it('字符截断、文件上限与解析超时均可见，JSONL 校验到每一行', async () => {
    expect(await inspectFiles([file('长.txt', 'abcdef')], 3)).toMatchObject({
      files: [{ text: 'abc' }],
      truncated: true,
    });
    expect(await inspect([file('a.md', 'a'), file('b.md', 'b')], { files: 1 })).toMatchObject({
      files: [{ path: 'a.md' }],
      truncated: true,
    });
    expect((await inspect([word('测试')], { timeoutMs: 1 })).files[0]?.error).toContain('超时');
    expect((await inspect([file('数据.jsonl', '{"a":1}\ninvalid')])).files[0]?.valid).toBe(false);
  });
});
