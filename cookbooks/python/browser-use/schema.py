"""Schema for browser-use cookbook."""

from typing import Optional

from pydantic import BaseModel, Field


class HNPostResult(BaseModel):
    """Structured result saved by each worker to output/result.json."""

    rank: int
    page: int
    position_on_page: int

    title: Optional[str] = None
    hn_item_id: Optional[str] = None
    hn_item_url: Optional[str] = None
    outbound_url: Optional[str] = None
    final_url: Optional[str] = None

    points: Optional[int] = None
    comments: Optional[int] = None

    summary: str  # Required: Markdown summary of the post content
    screenshots: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    error: Optional[str] = None
