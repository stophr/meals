FROM python:3.11-slim

WORKDIR /app

# libGL/glib are needed by opencv (a RapidOCR dependency).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "fastapi>=0.110" "uvicorn[standard]>=0.29" \
    "rapidocr-onnxruntime>=1.3,<2" "onnxruntime>=1.17" \
    "pillow>=10" "numpy<2"

COPY app.py .

# Warm the models into the image so first request is fast (they ship inside the package).
RUN python -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR()"

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
