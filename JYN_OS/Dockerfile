FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=11435
COPY . /app/JYN_OS/
EXPOSE 11435
CMD ["python3", "/app/JYN_OS/svl364_standalone_ollama.py", "11435"]
