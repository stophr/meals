# Local OCR (self-hosted vision model)

Receipt/flyer OCR runs against a **local vision model** by default (`OCR_PROVIDER=local`) —
no data leaves the host. The API talks to any **OpenAI-compatible** server over
`/v1/chat/completions` with an image + a JSON-schema response format, then validates the
result against the shared Zod schema. Claude remains available as an alternate provider
(`OCR_PROVIDER=claude`).

## Model choice

Research summary for **grocery receipt → structured JSON** by VRAM budget:

| Model | Params | ~VRAM (4-bit) | Output | Notes |
|---|---|---|---|---|
| **Qwen2.5-VL-3B-Instruct** ⭐ | 3B | ~3–6 GB | JSON via prompt | Best small-model OCR (OCRBench ~810). Default. |
| NuExtract 2.0 | 2B | ~2.5–3.5 GB | schema→JSON | Purpose-built for document extraction |
| InternVL3-2B | 2B | ~2.5–3.5 GB | JSON via prompt | Strong DocVQA at 2B |
| Moondream2 | ~2B | 1.5–2 GB | text | Lightest; weak on dense/messy receipts |
| PaddleOCR-VL / GOT-OCR2.0 | 0.9B / 0.58B | ~1.5–2 GB | markdown/text | Transcription only → needs a parse step |

**Recommended for a 6–8 GB GPU (RTX 3060/4060): `Qwen/Qwen2.5-VL-3B-Instruct`** — the app's
default. On a strict 4 GB card, drop to NuExtract-2B or Moondream2 and cap image resolution.

> **Accuracy caveat:** small VLMs are not as reliable zero-shot as Claude on messy receipts.
> The review queue is the safety net — every confirmed line becomes labeled data you can later
> use to **fine-tune** a 2–3B model toward ~98% (see Sources). We run local-only, so lean on
> the review step and the totals-checksum `confidence` the extractor returns.

## Serve it — Ollama (default, simplest)

```bash
ollama pull qwen2.5vl:3b
# Ollama exposes an OpenAI-compatible API at http://localhost:11434/v1 (this is the app default)
```

That's it — the app's defaults already point here (`OCR_LOCAL_BASE_URL=http://localhost:11434/v1`,
`OCR_LOCAL_MODEL=qwen2.5vl:3b`). If a server ignores `response_format`, the prompt still asks for
JSON-only and the extractor strips code fences before validating.

## Serve it — vLLM (optional, higher throughput)

vLLM gives better GPU utilization but is fussier to install (CUDA/torch). If it fails to start,
just use Ollama above.

```bash
pip install vllm
vllm serve Qwen/Qwen2.5-VL-3B-Instruct \
  --port 8000 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.9 \
  --limit-mm-per-prompt image=1 \
  --mm-processor-kwargs '{"max_pixels": 1048576}'   # cap image tokens (~1024x1024) to bound VRAM
```

Then set `OCR_LOCAL_BASE_URL=http://localhost:8000/v1` and `OCR_LOCAL_MODEL=Qwen/Qwen2.5-VL-3B-Instruct`.

## Point the app at it

`.env` (these are the built-in defaults — you only need to set them to override):

```dotenv
OCR_PROVIDER=local
OCR_LOCAL_BASE_URL=http://localhost:11434/v1       # Ollama
OCR_LOCAL_MODEL=qwen2.5vl:3b
OCR_LOCAL_API_KEY=                                  # usually empty for local servers
```

Running the API in Docker? The model server is on the host, so use
`OCR_LOCAL_BASE_URL=http://host.docker.internal:11434/v1` (compose already sets this default and
adds the `host.docker.internal` host mapping).

## Smoke test

```bash
# 1. server is up
curl -s http://localhost:11434/v1/models | jq '.data[].id'

# 2. end-to-end through the API (providerId optional; enables product matching)
curl -s -F 'file=@receipt.jpg' -F 'providerId=<PROVIDER_ID>' \
  http://localhost:3001/ingest/receipt | jq
# -> { jobId, lineCount, confidence, modelUsed }
# then review: GET /review/pending  ·  POST /review/lines/:id/resolve
```

## Sources

- [Best Local Vision Models for Private OCR (2026) — MyLocalAI](https://mylocalai.org/blog/best-local-vision-model-ocr)
- [7 Best Open-Source OCR Models 2025 — E2E Networks](https://www.e2enetworks.com/blog/complete-guide-open-source-ocr-models-2025)
- [Qwen2.5-VL Technical Report (OCRBench)](https://arxiv.org/pdf/2502.13923)
- [InternVL3 report — 2B/8B OCR benchmarks](https://arxiv.org/pdf/2504.10479)
- [Extracting invoice/receipt data as JSON with fine-tuned VLMs — CloudThat](https://www.cloudthat.com/resources/blog/extracting-invoice-and-receipt-data-as-json-using-fine-tuned-vlms)
- [Fine-tuning SmolVLM for receipt OCR — DebuggerCafe](https://debuggercafe.com/fine-tuning-smolvlm-for-receipt-ocr/)
- [NuExtract 3: self-hosted VLM for structured extraction](https://www.buildmvpfast.com/blog/nuextract3-open-weight-vlm-structured-extraction-self-hosted-2026)
