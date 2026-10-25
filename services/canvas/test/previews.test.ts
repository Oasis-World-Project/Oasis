import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createPreviewService, defaultPreviewLimits } from '../src/service/preview-service.ts';

const zip = (entries: Record<string, string>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)])),
    ),
  );
const preview = createPreviewService();

describe('有界文件预览转换', () => {
  it('读取多工作表和公式缓存，不执行公式或工作簿中的链接', async () => {
    const bytes = zip({
      '[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      '_rels/.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml':
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="一月" sheetId="1" r:id="r1"/><sheet name="二月" sheetId="2" r:id="r2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>销售</t></is></c><c r="B1"><f>SUM(10,20)</f><v>30</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml':
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>40</v></c></row></sheetData></worksheet>',
    });
    expect(await preview('book.xlsx', bytes)).toMatchObject({
      kind: 'table',
      sheets: [
        { name: '一月', rows: [['销售', 30]] },
        { name: '二月', rows: [[40]] },
      ],
      warning: expect.stringContaining('不会重算'),
    });
  });
  it('解析有引号、逗号、换行的 CSV；JSONL 保留对象字段，不执行公式', async () => {
    expect(
      await preview('a.csv', Buffer.from('姓名,备注\n甲,"a,b\n第二行"\n乙,=1+1')),
    ).toMatchObject({
      kind: 'table',
      sheets: [
        {
          rows: [
            ['姓名', '备注'],
            ['甲', 'a,b\n第二行'],
            ['乙', '=1+1'],
          ],
          truncated: false,
        },
      ],
    });
    expect(
      await preview(
        'a.jsonl',
        Buffer.from('{"q":"问题","meta":{"a":1}}\n{"q":"第二条","answer":true}'),
      ),
    ).toMatchObject({
      kind: 'table',
      sheets: [
        {
          rows: [
            ['q', 'meta', 'answer'],
            ['问题', '{"a":1}', null],
            ['第二条', null, true],
          ],
        },
      ],
    });
    await expect(preview('bad.jsonl', Buffer.from('{oops}'))).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(preview('bad.csv', Buffer.from('a,"b"junk'))).rejects.toThrow();
  });
  it('超过 1000 行明确截断；超过列上限拒绝，空文件拒绝', async () => {
    const result = await preview(
      'long.tsv',
      Buffer.from(Array.from({ length: 1500 }, (_, i) => `${i}\t内容`).join('\n')),
    );
    expect(result).toMatchObject({ kind: 'table', sheets: [{ truncated: true }] });
    if (result.kind === 'table') expect(result.sheets[0]!.rows).toHaveLength(1000);
    await expect(
      preview('wide.csv', Buffer.from(Array(101).fill('x').join(','))),
    ).rejects.toThrow();
    await expect(preview('empty.csv', Buffer.alloc(0))).rejects.toThrow();
  });
  it('真实 DOCX XML 转正文；外部图片不读取，javascript 链接留给前端统一清洗', async () => {
    const bytes = zip({
      '[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文报告 123</w:t></w:r></w:p></w:body></w:document>',
    });
    const result = await preview('报告.docx', bytes);
    expect(result).toEqual({ kind: 'html', html: '<p>中文报告 123</p>' });
  });
  it('ZIP 体积按实际解压计量，并拒绝 DTD、穿越路径及损坏 Office', async () => {
    const small = createPreviewService({ ...defaultPreviewLimits, unzipBytes: 100 });
    await expect(
      small('bomb.docx', zip({ 'word/document.xml': 'a'.repeat(2000) })),
    ).rejects.toThrow();
    await expect(
      preview(
        'entity.docx',
        zip({
          'word/document.xml': '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>',
        }),
      ),
    ).rejects.toThrow();
    await expect(preview('path.xlsx', zip({ '../word/document.xml': '<x />' }))).rejects.toThrow();
    await expect(preview('bad.xlsx', Buffer.from('not-a-zip'))).rejects.toThrow();
  });
  it('并发槽用完即拒绝，完成后释放；解析超时能终止', async () => {
    const one = createPreviewService({ ...defaultPreviewLimits, concurrency: 1 });
    const first = one('a.csv', Buffer.from('a,b'));
    await expect(one('b.csv', Buffer.from('a,b'))).rejects.toMatchObject({ statusCode: 503 });
    await first;
    expect(await one('c.csv', Buffer.from('a,b'))).toMatchObject({ kind: 'table' });
    await expect(
      createPreviewService({ ...defaultPreviewLimits, timeoutMs: 1 })('a.csv', Buffer.from('a')),
    ).rejects.toThrow('超时');
  });
});
