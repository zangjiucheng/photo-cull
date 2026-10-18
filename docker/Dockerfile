FROM node:20-slim AS web

WORKDIR /app

COPY frontend/package*.json ./frontend/
RUN cd frontend && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci

COPY frontend ./frontend
COPY server/editing_presets.json ./server/editing_presets.json
RUN cd frontend && npm run build

FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV FLASK_HOST=0.0.0.0
ENV FLASK_PORT=5000

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./
COPY server ./server
COPY templates ./templates
COPY --from=web /app/static ./static

EXPOSE 5000

CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:5000", "app:app"]
