"""Fetch and prepare rent roll PDFs for pipeline processing."""

import json
import shutil
from pathlib import Path


def load_rent_rolls(pdf_dir: str) -> list[dict]:
    """Load rent roll PDFs from a directory into pipeline input format.

    Args:
        pdf_dir: Directory containing rent roll PDF files

    Returns:
        List of file maps, each with the PDF under its original filename
    """
    shutil.rmtree("intermediate", ignore_errors=True)
    shutil.rmtree("output", ignore_errors=True)

    pdf_path = Path(pdf_dir)
    pdfs = sorted(pdf_path.glob("*.pdf"))

    if not pdfs:
        raise ValueError(f"No PDF files found in {pdf_dir}")

    items = []
    for i, pdf in enumerate(pdfs):
        items.append({pdf.name: pdf.read_bytes()})
        print(f"  [{i}] {pdf.name}")

    return items


def save_intermediate(results, step_name: str) -> None:
    """Save intermediate results to intermediate/{step_name}/.

    Args:
        results: List of SwarmResult objects
        step_name: Name of the pipeline step (e.g., 'extract', 'analyze')
    """
    step_dir = Path(f"intermediate/{step_name}")
    step_dir.mkdir(parents=True, exist_ok=True)

    for r in results:
        item_dir = step_dir / f"item_{r.meta.item_index:02d}"
        item_dir.mkdir(exist_ok=True)

        (item_dir / "status.txt").write_text(r.status)

        if r.data:
            data = r.data.model_dump() if hasattr(r.data, 'model_dump') else r.data
            (item_dir / "data.json").write_text(json.dumps(data, indent=2))

        if r.error:
            (item_dir / "error.txt").write_text(r.error)
