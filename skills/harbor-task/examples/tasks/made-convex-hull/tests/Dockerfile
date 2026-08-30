# Built for real: a "separate" verifier over environment/Dockerfile.
# The verifier carries its OWN copy of made_model.py on purpose — grading against
# a model the agent could have edited would let a submission rewrite its own
# ground truth.
FROM python:3.12-slim
WORKDIR /app
