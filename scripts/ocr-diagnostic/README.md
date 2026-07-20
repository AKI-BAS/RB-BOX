# PaddleOCR-VL diagnostic

A local, one-off, read-only diagnostic: does PaddleOCR-VL (GPU) recover more
usable text/tables than the current pdf-parse extraction path, on a small
deliberately-varied sample of real RB-BOX documents? Runs entirely on the
user's Windows machine (RTX 3060 Laptop, 6GB). No production/app code is
touched, no database writes happen anywhere in this directory, and no
Anthropic/cloud OCR is used — only local Supabase reads and a local Docker
container.

## Prerequisites

- Node 20+ on the Windows host
- Docker Desktop for Windows, running, with the WSL2 backend (`docker info`
  succeeds)
- Read-only Supabase credentials in the project's `.env.local`
  (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — service-role is
  used for SELECT-only reads across all documents regardless of
  `access_level`, never for writes)
- An NVIDIA driver supporting **CUDA 12.6 or later** (see "GPU image" below)

## Run order

1. **`node select-sample.mjs`**
   Queries Supabase (read-only) for 10 deliberately-varied documents and
   writes `sample/{source_slug}/{doc_id}.json` (title, external_url,
   source_id, source_slug, extracted_text, metadata) plus, where the
   download succeeds, `sample/{source_slug}/{doc_id}.pdf`. Some sources
   (byggingarreglugerd, hms-rb-blod-web) are HTML-native — their
   `external_url` is a web page, not a PDF file — those downloads are
   EXPECTED to fail and are logged/skipped, not treated as an error.
   Writes `sample/selection-summary.json` with what was picked and what
   was skipped.

2. **Driver update + GPU passthrough check** (manual, on the Windows host)
   PaddleOCR-VL's NVIDIA GPU image requires a driver supporting CUDA 12.6+.
   Update via GeForce Experience or https://www.nvidia.com/drivers, restart
   if the installer asks, then confirm `nvidia-smi` reports a driver new
   enough for CUDA 12.6+ before continuing.

3. **OCR container**
   ```bash
   docker pull ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlepaddle/paddleocr-vl:latest-nvidia-gpu

   docker run \
       -it \
       --gpus all \
       --network host \
       --user root \
       -v "$(pwd)/scripts/ocr-diagnostic:/workspace/ocr-diagnostic" \
       ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlepaddle/paddleocr-vl:latest-nvidia-gpu \
       python /workspace/ocr-diagnostic/run-ocr.py
   ```
   `run-ocr.py` checks `torch.cuda.is_available()` at startup and fails
   loudly (no CPU fallback) if the GPU isn't visible inside the container —
   that's a deliberate hard stop, not a bug, since a CPU run would produce
   meaningless timing numbers for what is specifically a GPU feasibility
   check. Do **not** use the `-sm120` (Blackwell) image variant — the RTX
   3060 is Ampere architecture, not Blackwell.

4. **`node build-report.mjs`**
   Reads `sample/{slug}/{id}.json` + `.ocr.md` + `.timing.json` for every
   doc that has all three, computes the pdf-parse-vs-OCR diff summary, and
   writes `output/report.md`.

## GPU image

Verified against the current PaddleOCR-VL usage tutorial
(paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html) at the
time this was written — the tag differs from earlier assumptions, so
double-check it against the docs again if a long time has passed before
Phase B actually runs:

- Correct tag: `ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlepaddle/paddleocr-vl:latest-nvidia-gpu`
- **Not** `:latest-gpu` (doesn't exist) and **not** `:latest-nvidia-gpu-sm120`
  (Blackwell-only — wrong architecture for this GPU)
- Requires Docker >= 19.03, NVIDIA driver supporting CUDA 12.6+, GPU compute
  capability >= 7.0 (RTX 3060 is 8.6 — comfortably above the minimum; the
  driver/CUDA version is the actual gating factor, not the GPU model)

## What's read-only, and how that's verified

Nothing in this directory ever calls Supabase's `insert`, `update`,
`upsert`, or `delete` — every Supabase call is `.select(...)`. Verify with:

```bash
grep -rniE "\.(insert|update|upsert|delete)\(" scripts/ocr-diagnostic/*.mjs
```

This should return nothing. If it ever does, stop and fix it before running
anything — this diagnostic must never write to `documents` or any other
table.

## Files

- `select-sample.mjs` — sample selection + PDF download (Phase A, safe to run)
- `run-ocr.py` — OCR runner, **runs inside the GPU container only** (Phase B)
- `build-report.mjs` — report builder (Phase B, after run-ocr.py)
- `sample/` — gitignored; populated by select-sample.mjs, contains real
  document text/PDFs, not meant to be committed
- `output/` — gitignored; contains report.md once build-report.mjs runs
