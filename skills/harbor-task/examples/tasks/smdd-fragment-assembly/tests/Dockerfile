# Built for real: this task has a "separate" verifier over environment/Dockerfile,
# which is the one path where the verifier owns its own image and dependencies
# installed here are genuinely present.
FROM python:3.12-slim
RUN pip install --no-cache-dir rdkit==2026.3.5
WORKDIR /app
