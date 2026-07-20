#!/usr/bin/env python3
"""
PaddleOCR-VL diagnostic — Phase B OCR runner.

AUTHOR ONLY IN PHASE A. This script is NOT executed until the user has
explicitly replied "proceed" and Phase B has begun. It is meant to run
INSIDE the paddleocr-vl NVIDIA-GPU Docker container (see README.md for the
exact `docker run` invocation), against the PDFs already downloaded by
select-sample.mjs under sample/{source_slug}/{doc_id}.pdf.

For each sample PDF:
  1. Render every page via pypdfium2 at 200 DPI (150 DPI retry on CUDA OOM).
  2. Run the PaddleOCR-VL pipeline on each rendered page image (GPU only —
     see the startup check below).
  3. Concatenate per-page markdown into sample/{slug}/{id}.ocr.md.
  4. Write timing info (pages, sec/page, wall clock, device) to
     sample/{slug}/{id}.timing.json.

Per-page failures are logged and skipped (the doc's run continues with
whatever pages succeeded) — a single bad page must not abort the whole
sample. A missing/unavailable GPU is different: that's a hard, loud
failure with no fallback, because a CPU run would produce misleading
timing numbers for a GPU feasibility diagnostic.

Python API confirmed against the current PaddleOCR-VL usage tutorial
(paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html) at
the time this was authored:

    from paddleocr import PaddleOCRVL
    pipeline = PaddleOCRVL(device="gpu:0")
    output = pipeline.predict(image_path_or_array)
    for res in output:
        res.save_to_markdown(save_path=...)

If the installed paddleocr package's API has since changed, fix the calls
below before running Phase B — don't silently adapt by falling back to a
different code path without updating this comment too.
"""

import json
import sys
import time
import traceback
from pathlib import Path

SAMPLE_DIR = Path(__file__).parent / "sample"
RENDER_DPI_DEFAULT = 200
RENDER_DPI_RETRY = 150  # fallback on CUDA OOM


def fail_loudly(message: str) -> None:
    print(f"\n{'=' * 60}\nFATAL: {message}\n{'=' * 60}\n", file=sys.stderr)
    sys.exit(1)


def check_gpu() -> str:
    """Never fall back to CPU — a CPU run gives meaningless timing numbers
    for what is specifically a GPU feasibility diagnostic. Exit loudly
    instead of silently degrading."""
    try:
        import torch
    except ImportError:
        fail_loudly("torch is not importable inside this container — cannot verify GPU availability.")

    available = torch.cuda.is_available()
    print(f"torch.cuda.is_available() = {available}")
    if not available:
        fail_loudly(
            "No CUDA device visible to torch inside the container. "
            "Check `docker run --gpus all`, the host NVIDIA driver (needs CUDA 12.6+), "
            "and nvidia-container-toolkit. Refusing to fall back to CPU."
        )

    device_name = torch.cuda.get_device_name(0)
    print(f"torch.cuda.get_device_name(0) = {device_name}")
    return device_name


def render_pages(pdf_path: Path, dpi: int):
    """Yields (page_index, PIL.Image) for every page in pdf_path at the
    given DPI, via pypdfium2."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        scale = dpi / 72  # pdfium's native unit is 1/72 inch, same as PDF points
        for i in range(len(pdf)):
            page = pdf[i]
            bitmap = page.render(scale=scale)
            yield i, bitmap.to_pil()
    finally:
        pdf.close()


def ocr_one_pdf(pipeline, pdf_path: Path, device_name: str) -> dict:
    doc_wall_start = time.monotonic()
    page_markdowns = []
    page_seconds = []
    pages_failed = []
    dpi_used = RENDER_DPI_DEFAULT

    try:
        pages = list(render_pages(pdf_path, RENDER_DPI_DEFAULT))
    except Exception as exc:
        print(f"  [{pdf_path.name}] FAILED to render pages at {RENDER_DPI_DEFAULT} DPI: {exc}")
        traceback.print_exc()
        return {
            "pdf": pdf_path.name,
            "pages": 0,
            "pages_failed": ["render"],
            "sec_per_page": None,
            "wall_clock_sec": time.monotonic() - doc_wall_start,
            "device": device_name,
            "dpi": dpi_used,
        }

    for page_index, image in pages:
        page_start = time.monotonic()
        try:
            output = pipeline.predict(image)
            md_parts = []
            for res in output:
                # save_to_markdown writes a file; we want the string too, so
                # grab it from the result object directly if exposed, else
                # fall back to reading the file it just wrote.
                if hasattr(res, "markdown"):
                    md_parts.append(res.markdown)
                else:
                    tmp_dir = pdf_path.parent / f".{pdf_path.stem}_page{page_index}_md"
                    res.save_to_markdown(save_path=str(tmp_dir))
                    for md_file in tmp_dir.glob("*.md"):
                        md_parts.append(md_file.read_text(encoding="utf-8"))
            page_markdowns.append("\n\n".join(md_parts))
            page_seconds.append(time.monotonic() - page_start)
        except Exception as exc:
            is_oom = "out of memory" in str(exc).lower() or "CUDA out of memory" in str(exc)
            if is_oom and dpi_used != RENDER_DPI_RETRY:
                print(f"  [{pdf_path.name}] page {page_index}: OOM at {RENDER_DPI_DEFAULT} DPI, retrying at {RENDER_DPI_RETRY} DPI")
                try:
                    import pypdfium2 as pdfium
                    pdf = pdfium.PdfDocument(str(pdf_path))
                    scale = RENDER_DPI_RETRY / 72
                    retry_image = pdf[page_index].render(scale=scale).to_pil()
                    pdf.close()
                    output = pipeline.predict(retry_image)
                    md_parts = []
                    for res in output:
                        if hasattr(res, "markdown"):
                            md_parts.append(res.markdown)
                    page_markdowns.append("\n\n".join(md_parts))
                    page_seconds.append(time.monotonic() - page_start)
                    continue
                except Exception as retry_exc:
                    print(f"  [{pdf_path.name}] page {page_index}: retry at {RENDER_DPI_RETRY} DPI also failed: {retry_exc}")
                    pages_failed.append(page_index)
                    continue
            print(f"  [{pdf_path.name}] page {page_index}: FAILED: {exc}")
            traceback.print_exc()
            pages_failed.append(page_index)

    wall_clock = time.monotonic() - doc_wall_start
    avg_sec_per_page = (sum(page_seconds) / len(page_seconds)) if page_seconds else None

    return {
        "pdf": pdf_path.name,
        "pages": len(pages),
        "pages_ok": len(page_seconds),
        "pages_failed": pages_failed,
        "sec_per_page": avg_sec_per_page,
        "wall_clock_sec": wall_clock,
        "device": device_name,
        "dpi": dpi_used,
        "_markdown": "\n\n---\n\n".join(page_markdowns),
    }


def main() -> None:
    device_name = check_gpu()

    from paddleocr import PaddleOCRVL

    print("Loading PaddleOCR-VL pipeline (device=gpu:0)...")
    pipeline = PaddleOCRVL(device="gpu:0")

    pdf_paths = sorted(SAMPLE_DIR.glob("*/*.pdf"))
    if not pdf_paths:
        fail_loudly(f"No PDFs found under {SAMPLE_DIR}/*/*.pdf — did select-sample.mjs run first?")

    print(f"Found {len(pdf_paths)} sample PDFs.\n")

    for pdf_path in pdf_paths:
        doc_id = pdf_path.stem
        slug_dir = pdf_path.parent
        print(f"Processing {slug_dir.name}/{pdf_path.name} ...")

        result = ocr_one_pdf(pipeline, pdf_path, device_name)

        md_path = slug_dir / f"{doc_id}.ocr.md"
        md_path.write_text(result.pop("_markdown", ""), encoding="utf-8")

        timing_path = slug_dir / f"{doc_id}.timing.json"
        timing_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

        print(
            f"  -> {result['pages_ok']}/{result['pages']} pages ok, "
            f"{result['sec_per_page']:.2f}s/page avg, "
            f"{result['wall_clock_sec']:.1f}s wall clock\n"
            if result.get("sec_per_page") is not None
            else f"  -> 0 pages succeeded\n"
        )

    print("Done.")


if __name__ == "__main__":
    main()
