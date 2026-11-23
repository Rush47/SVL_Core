# Multi-stage Dockerfile for SVL Python OS
FROM python:3.12-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

FROM python:3.12-slim

WORKDIR /app

# Copy installed packages
COPY --from=builder /root/.local /root/.local

# Copy application
COPY backend/ ./backend/
COPY SVL_CoreOS_2/ ./SVL_CoreOS_2/

# Make sure scripts in .local are usable
ENV PATH=/root/.local/bin:$PATH

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8085/health')" || exit 1

EXPOSE 8085

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8085", "--workers", "4"]
