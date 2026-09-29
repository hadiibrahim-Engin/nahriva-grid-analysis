"""Versioned, source-neutral import contract. All simulation timestamps are UTC."""

from datetime import datetime, timezone
from typing import Literal
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    field_validator,
    model_validator,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Element(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=300)
    className: str | None = Field(default=None, max_length=100)
    type: str = Field(min_length=1, max_length=100)
    path: str | None = Field(default=None, max_length=2000)


class Run(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=300)
    project: str = Field(min_length=1, max_length=300)
    study_case: str = Field(min_length=1, max_length=300)
    source: str = Field(min_length=1, max_length=100)
    status: Literal["completed", "partial", "failed"] = "completed"


class Metric(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$")
    name: str = Field(min_length=1, max_length=200)
    unit: str = Field(max_length=40)
    lower: FiniteFloat | None = None
    upper: FiniteFloat | None = None

    @model_validator(mode="after")
    def bounds(self):
        if (
            self.lower is not None
            and self.upper is not None
            and self.lower >= self.upper
        ):
            raise ValueError("lower must be less than upper")
        return self


class Sample(StrictModel):
    timestamp: datetime
    element_id: str
    metric_id: str
    value: FiniteFloat | None
    status: Literal["ok", "warning", "failed"] = "ok"

    @field_validator("timestamp")
    @classmethod
    def utc_timestamp(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("A timezone offset is required")
        return value.astimezone(timezone.utc)


class RunBundle(StrictModel):
    schema_version: Literal[1] = 1
    run: Run
    elements: list[Element] = Field(min_length=1, max_length=10000)
    metrics: list[Metric] = Field(min_length=1, max_length=100)
    samples: list[Sample] = Field(max_length=250000)

    @model_validator(mode="after")
    def references(self):
        elements = {e.id for e in self.elements}
        metrics = {m.id for m in self.metrics}
        if len(elements) != len(self.elements) or len(metrics) != len(self.metrics):
            raise ValueError("Duplicate element or metric ID")
        seen = set()
        for sample in self.samples:
            if sample.element_id not in elements or sample.metric_id not in metrics:
                raise ValueError("Unknown sample element_id or metric_id")
            key = (sample.element_id, sample.metric_id, sample.timestamp)
            if key in seen:
                raise ValueError("Duplicate sample key")
            seen.add(key)
        return self


class RunSummary(Run):
    start: datetime | None
    end: datetime | None
    sample_count: int


class Statistics(StrictModel):
    count: int
    missing: int
    mean: float | None
    min: float | None
    max: float | None
    std_dev: float | None
    p95: float | None
    violations: int


class ElementResult(Element, Statistics):
    pass


class SeriesPoint(StrictModel):
    timestamp: datetime
    mean: float | None
    min: float | None = None
    max: float | None = None
    count: int | None = None


class HistogramBin(StrictModel):
    lower: float
    upper: float
    count: int


class DurationPoint(StrictModel):
    percent: int
    value: float


class Comparison(StrictModel):
    run: RunSummary
    matched_count: int
    mean_delta: float | None
    points: list[SeriesPoint]


class AnalysisMeta(StrictModel):
    source: str
    sample_count: int
    element_count: int
    timezone: str
    series_aggregation: str
    duration_resolution: str
    threshold_basis: str
    start: datetime | None
    end: datetime | None


class AnalysisResponse(StrictModel):
    run: RunSummary
    metric: Metric
    stats: Statistics
    points: list[SeriesPoint]
    elements: list[ElementResult]
    histogram: list[HistogramBin]
    duration: list[DurationPoint]
    comparison: Comparison | None
    meta: AnalysisMeta
