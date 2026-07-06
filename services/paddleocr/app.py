# Lightweight OCR sidecar: PP-OCR models via RapidOCR (ONNX runtime — no paddlepaddle, CPU-fast).
# Reads all printed text off an image. The API turns that into a PLU using the IFPS table.

import base64
import io

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

app = FastAPI()
engine = RapidOCR()


class OcrRequest(BaseModel):
    imageBase64: str


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr")
def ocr(req: OcrRequest):
    raw = base64.b64decode(req.imageBase64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    result, _elapse = engine(np.array(img))
    # result: list of [box, text, score] (or None when nothing detected)
    lines = [
        {"text": item[1], "conf": float(item[2])}
        for item in (result or [])
        if item and len(item) >= 3 and item[1]
    ]
    return {"lines": lines}
