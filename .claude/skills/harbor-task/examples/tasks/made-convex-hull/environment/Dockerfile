# Standard library only: the analytic oracle needs no scientific stack, which is
# what keeps this task offline, CPU-only and reproducible.
FROM python:3.12-slim

WORKDIR /app
COPY made_model.py oracle.py /app/
COPY data /app/data
RUN chmod +x /app/oracle.py
