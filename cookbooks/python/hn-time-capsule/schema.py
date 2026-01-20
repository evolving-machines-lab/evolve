"""Structured output schema for HN Time Capsule analysis."""

from pydantic import BaseModel, Field


class Award(BaseModel):
    user: str = Field(description="HN username")
    reason: str = Field(description="Why they were right/wrong in hindsight")


class Grade(BaseModel):
    grade: str = Field(description="Letter grade (A+ to F)")
    rationale: str = Field(description="Brief explanation for the grade")


class Analysis(BaseModel):
    title: str = Field(description="Article title")
    summary: str = Field(description="Brief summary of article and discussion")
    what_happened: str = Field(description="What actually happened to this topic/company/technology")
    most_prescient: Award = Field(description="Commenter who best predicted the future")
    most_wrong: Award = Field(description="Commenter who was most wrong")
    notable_aspects: str = Field(description="Other fun or notable aspects of the article or discussion")
    grades: dict[str, Grade] = Field(description="HN username → grade with rationale")
    score: int = Field(description="0-10 how interesting this retrospective is")
