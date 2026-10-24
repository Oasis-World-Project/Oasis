"""沙箱真实软件验收：由 pnpm sandbox:check 在断网、2 核、2 GB 临时容器中执行。"""
import importlib
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
    print("PASS: ffmpeg audio generation and ffprobe", flush=True)

    class Catalog(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"tools":[]}')

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Catalog) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            listing = run("oasis-tool", "list", env={
                **os.environ,
                "OASIS_MODEL_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                "OASIS_TOOL_AUTH": "local-test-only",
            })
            for name in ["libreoffice-writer", "ffmpeg", "openpyxl", "pandas", "weasyprint"]:
                assert name in listing.lower(), name
        finally:
            server.shutdown()
            thread.join()
    print("PASS: oasis-tool list displays installed software", flush=True)
    generated_bytes = sum(path.stat().st_size for path in root.rglob("*") if path.is_file())

print(f"PASS: all software checks completed; {generated_bytes} bytes of generated files removed", flush=True)
