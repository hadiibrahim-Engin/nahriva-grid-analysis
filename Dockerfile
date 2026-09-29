FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /bin/
WORKDIR /app/backend
COPY backend/ ./
RUN uv sync --frozen --no-dev --no-editable && useradd --uid 10001 --create-home analysis && mkdir -p /data && chown analysis:analysis /data
COPY --from=frontend /app/frontend/dist /app/frontend/dist
ENV APP_ENV=production ANALYSIS_MODE=sqlite ANALYSIS_DB_PATH=/data/analysis.sqlite3
USER analysis
EXPOSE 8016
CMD ["/app/backend/.venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8016"]
