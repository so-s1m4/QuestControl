FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libreoffice-writer \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir -r requirements.txt
COPY server.py ./
USER 65534:65534
EXPOSE 8080
CMD ["python", "-I", "server.py"]
