"""沙箱真实软件验收：由 pnpm sandbox:check 在断网、2 核、2 GB 临时容器中执行。"""
import importlib
import csv
import json
import os
from pathlib import Path
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread


def run(*args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}")
    return result.stdout


for module in [
    "pandas", "openpyxl", "docx", "pptx", "pdfplumber", "pypdf", "matplotlib",
    "PIL", "pyarrow", "weasyprint", "jinja2", "markdown",
]:
    importlib.import_module(module)
run("python3", "-m", "pip", "check")
print("PASS: Python imports and dependency consistency", flush=True)

from docx import Document
from docx.oxml.ns import qn
from pptx import Presentation
from pptx.util import Inches
from openpyxl import Workbook, load_workbook
from pypdf import PdfReader
from weasyprint import HTML
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib import font_manager
from PIL import Image

with tempfile.TemporaryDirectory(prefix="oasis-file-tools-") as tmp:
    root = Path(tmp)
    converted = root / "converted"
    converted.mkdir()
    text = "绿洲季度报告销售收入"

    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Noto Sans CJK JP"
    style.element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "Noto Sans CJK JP")
    doc.add_paragraph(text)
    doc.save(root / "report.docx")

    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(2))
    box.text_frame.text = text
    box.text_frame.paragraphs[0].runs[0].font.name = "Noto Sans CJK JP"
    deck.save(root / "slides.pptx")

    for name in ["report.docx", "slides.pptx"]:
        run("soffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(converted), str(root / name))
        pdf = converted / (Path(name).stem + ".pdf")
        assert pdf.stat().st_size > 0
        extracted = run("pdftotext", str(pdf), "-")
        assert text in "".join(extracted.split()), extracted
        assert len(PdfReader(pdf).pages) == 1
        run("pdftoppm", "-scale-to", "800", "-singlefile", "-png", str(pdf), str(root / Path(name).stem))
        with Image.open(root / (Path(name).stem + ".png")) as rendered:
            rendered.verify()
    print("PASS: DOCX/PPTX -> PDF, Chinese text extraction and page rendering", flush=True)

    book = Workbook()
    sheet = book.active
    sheet.title = "销售"
    sheet.append(["收入", 10])
    sheet.append(["收入", 20])
    sheet["B3"] = "=SUM(B1:B2)"
    book.save(root / "sales.xlsx")
    run("soffice", "--headless", "--norestore", "--convert-to", "xlsx", "--outdir", str(converted), str(root / "sales.xlsx"))
    assert load_workbook(converted / "sales.xlsx", data_only=True)["销售"]["B3"].value == 30
    assert load_workbook(converted / "sales.xlsx")["销售"]["B3"].value == "=SUM(B1:B2)"
    data = pd.DataFrame({"品类": ["文档", "图片"], "数量": [10, 20]})
    data.to_parquet(root / "data.parquet", index=False)
    assert pd.read_parquet(root / "data.parquet").equals(data)
    print("PASS: Excel formula recalculation and Parquet round trip", flush=True)

    font_manager.findfont("Noto Sans CJK JP", fallback_to_default=False)
    fig, ax = plt.subplots()
    ax.bar(data["品类"], data["数量"])
    ax.set_title(text)
    fig.savefig(root / "chart.png")
    plt.close(fig)
    HTML(string=f'<html lang="zh"><style>body{{font-family:"Noto Sans CJK JP"}}</style><p>{text}</p></html>').write_pdf(root / "html.pdf")
    assert text in "".join(run("pdftotext", str(root / "html.pdf"), "-").split())
    print("PASS: Chinese chart fonts and HTML -> PDF", flush=True)

    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", str(root / "sample.wav"))
    probe = json.loads(run("ffprobe", "-v", "error", "-show_format", "-of", "json", str(root / "sample.wav")))
    assert float(probe["format"]["duration"]) == 1
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(root / "sample.wav"), "-f", "segment", "-segment_time", "0.4", "-segment_list", str(root / "segments.csv"), "-segment_list_type", "csv", str(root / "part-%02d.wav"))
    segments = list(csv.reader((root / "segments.csv").open()))
    assert len(segments) >= 2
    previous_end = 0.0
    for filename, start, end in segments:
        assert abs(float(start) - previous_end) < 0.001
        assert float(end) > float(start)
        assert Path(filename).name == filename
        assert (root / filename).is_file()
        previous_end = float(end)
    assert abs(previous_end - 1.0) < 0.05
    print("PASS: ffmpeg audio generation and ffprobe", flush=True)
    print("PASS: audio segments preserve actual source start/end times for transcript citations", flush=True)

    class Catalog(BaseHTTPRequestHandler):
        calls = []

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"tools":[]}')

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            Catalog.calls.append((self.path, body))
            assert body["max_cost_micro"] == 200000
            if self.path.endswith("chat/completions"):
                assert body["model"] == "test/model"
                result = {"choices": [{"message": {"content": "generated"}}], "oasis": {"costMicro": 10}}
            else:
                assert self.path.endswith("tools/jev.decide")
                result = {"text": "good", "data": {"choice": "good"}, "costMicro": 20}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Catalog) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            tool_env = {
                **os.environ,
                "OASIS_MODEL_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                "OASIS_TOOL_AUTH": "local-test-only",
                "OASIS_MODEL": "test/model",
            }
            listing = run("oasis-tool", "list", env=tool_env)
            for name in ["libreoffice-writer", "ffmpeg", "openpyxl", "pandas", "weasyprint", "chromium", "playwright-core"]:
                assert name in listing.lower(), name
            for tool, row in [("text.batch", {"id": "1", "prompt": "sample"}), ("jev.decide", {"id": "1", "question": "clear?", "scale": ["bad", "good"]})]:
                source = root / f"{tool}.jsonl"
                source.write_text(json.dumps(row))
                destination = f"out/{tool}.jsonl"
                # 每行的花费上限是可选的（2026-11-03 起）：这里给出来，上面的假服务核对它原样传到了请求里
                run("oasis-tool", tool, "--in", str(source), "--out", destination, "--row_budget_micro", "200000", cwd=root, env=tool_env)
                source.unlink()
                run("oasis-tool", tool, "--resume", "true", "--out", destination, cwd=root, env=tool_env)
                assert json.loads((root / destination).read_text())["status"] == "completed"
            assert len(Catalog.calls) == 2, Catalog.calls
            print("PASS: batch generation/scoring CLI, checkpoint resume without duplicate requests", flush=True)
        finally:
            server.shutdown()
            thread.join()
    print("PASS: oasis-tool list displays installed software", flush=True)

    # 各场景预装的命令行工具：文档、数据、图片、音频、代码项目
    for command in [
        ("git", "--version"), ("pandoc", "--version"), ("sqlite3", "--version"), ("jq", "--version"),
        ("magick", "-version"), ("sox", "--version"), ("rg", "--version"), ("zip", "-v"), ("unzip", "-v"),
        ("make", "--version"), ("g++", "--version"), ("esbuild", "--version"), ("tsc", "--version"),
    ]:
        run(*command)
    (root / "note.md").write_text("# 标题\n\n正文 **加粗**\n")
    assert "<strong>加粗</strong>" in run("pandoc", str(root / "note.md"), "-t", "html")
    assert run("sqlite3", ":memory:", "select 6 * 7;").strip() == "42"
    assert run("jq", "-r", ".a.b", input='{"a":{"b":"ok"}}').strip() == "ok"
    run("magick", "-size", "64x48", "xc:#3366cc", str(root / "block.png"))
    assert Image.open(root / "block.png").size == (64, 48)
    run("sox", "-n", "-r", "8000", str(root / "tone.wav"), "synth", "0.2", "sine", "440")
    assert (root / "tone.wav").stat().st_size > 1000
    (root / "entry.ts").write_text("const n: number = 6 * 7;\nconsole.log(n);\n")
    run("esbuild", str(root / "entry.ts"), "--bundle", f"--outfile={root / 'entry.js'}")
    assert run("node", str(root / "entry.js")).strip() == "42"
    print("PASS: command-line tools for documents, data, images, audio and code projects", flush=True)

    # 浏览器：干活的 AI 用它打开自己做的页面、按键、读页面状态、截图。页面是一个一直在动的小游戏画面。
    site = root / "site"
    site.mkdir()
    (site / "index.html").write_text(
        """<!doctype html><meta charset="utf-8"><title>躲雨</title>
<canvas id="stage" width="800" height="600"></canvas><p id="hud">0</p>
<script>
const state = (window.state = { x: 0, jumped: false, frames: 0 });
const ctx = document.getElementById('stage').getContext('2d');
addEventListener('keydown', (event) => {
  if (event.code === 'ArrowRight') state.x += 10;
  if (event.code === 'Space') state.jumped = true;
});
function frame() {
  state.frames += 1;
  ctx.fillStyle = '#101830'; ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = '#f08a24'; ctx.fillRect(100 + state.x, 480, 48, 64);
  ctx.fillStyle = '#9cc8ff';
  for (let i = 0; i < 40; i += 1) ctx.fillRect((i * 53) % 800, (state.frames * 7 + i * 31) % 600, 2, 14);
  document.getElementById('hud').textContent = String(state.frames);
  requestAnimationFrame(frame);
}
frame();
</script>
"""
    )
    (root / "drive.mjs").write_text(
        """import { chromium } from 'playwright-core';
const [url, shot] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(url);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Space');
await page.waitForFunction(() => window.state.frames > 30);
const state = await page.evaluate(() => ({
  ...window.state,
  webgl: Boolean(document.createElement('canvas').getContext('webgl')),
}));
await page.screenshot({ path: shot });
await browser.close();
console.log(JSON.stringify({ state, errors }));
"""
    )
    url = (site / "index.html").as_uri()
    driven = subprocess.run(
        ["node", str(root / "drive.mjs"), url, str(root / "play.png")],
        capture_output=True, text=True, timeout=120,
    )
    assert driven.returncode == 0, driven.stderr
    played = json.loads(driven.stdout)
    assert played["errors"] == [], played
    assert played["state"]["x"] == 10 and played["state"]["jumped"] and played["state"]["frames"] > 30, played
    assert played["state"]["webgl"], "WebGL context unavailable"
    assert len(Image.open(root / "play.png").convert("RGB").getcolors(maxcolors=2**24)) >= 3, "screenshot is one flat colour"
    run("chromium", "--headless", f"--screenshot={root / 'cli.png'}", "--window-size=800,600", url)
    assert (root / "cli.png").stat().st_size > 1000
    peak = Path("/sys/fs/cgroup/memory.peak")
    pids = Path("/sys/fs/cgroup/pids.peak")
    usage = ", ".join(
        f"{label} {value}"
        for label, value in [
            ("memory peak", f"{int(peak.read_text()) // 2**20} MiB" if peak.exists() else ""),
            ("pids peak", pids.read_text().strip() if pids.exists() else ""),
        ]
        if value
    )
    print(f"PASS: browser drives a local page (keys, page state, WebGL, screenshot); {usage}", flush=True)
    generated_bytes = sum(path.stat().st_size for path in root.rglob("*") if path.is_file())

print(f"PASS: all software checks completed; {generated_bytes} bytes of generated files removed", flush=True)
