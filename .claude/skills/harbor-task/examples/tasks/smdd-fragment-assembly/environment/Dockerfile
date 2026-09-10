FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir rdkit==2026.3.5

WORKDIR /app
COPY data /app/data
COPY fetch_inputs.sh /usr/local/bin/fetch_inputs.sh

# The pocket structure is benchmark data. It is fetched at BUILD time from the
# upstream release rather than vendored into this repository — see the note on
# the canary header in ../../README.md.
RUN bash /usr/local/bin/fetch_inputs.sh /app/data
