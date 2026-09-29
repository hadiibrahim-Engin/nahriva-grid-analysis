from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional


# --- Errors ---
class ErrorResponse(BaseModel):
    """Consistent error envelope returned for every handled failure.

    `error_code` is stable and machine-readable; `message` is safe,
    user-facing text (never raw SQL/Oracle internals). `request_id`
    correlates the response with the structured access log.
    """

    error_code: str
    message: str
    details: Optional[dict[str, Any]] = None
    request_id: Optional[str] = None
    suggested_action: Optional[str] = None

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "error_code": "RAW_RANGE_TOO_LARGE",
                    "message": "Rohdatenbereich ist zu groß.",
                    "details": {"estimated_points": 2880, "max_points": 2000},
                    "request_id": "01JZ7E2K4F9T4MX9WPK2W1QX1E",
                    "suggested_action": "limit/cursor verwenden oder /aggregate wählen.",
                }
            ]
        }
    )


# --- Auth ---
class Token(BaseModel):
    access_token: str
    token_type: str

class UserResponse(BaseModel):
    username: str
    role: str


# --- Facilities (from FDWH STAMMDATEN) ---
class FacilityResponse(BaseModel):
    id: str = Field(..., description="ANLAGENNUMMER from FDWH")
    name: str = Field(..., description="ANLAGENNAME from FDWH")
    spannungsebene: Optional[str] = Field(None, description="Voltage level, when available")

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {"id": "10001234", "name": "UW Nord", "spannungsebene": "110 kV"}
            ]
        }
    )


# --- Components (= Felder from FDWH STAMMDATEN) ---
class ComponentResponse(BaseModel):
    id: str = Field(..., description="Composite id: ANLAGENNUMMER_FELDNUMMER")
    facility_id: str = Field(..., description="ANLAGENNUMMER")
    name: str = Field(..., description="FELDNAME_KURZ")
    spannungsebene: Optional[str] = Field(None, description="Voltage level, when available")

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "id": "10001234_020",
                    "facility_id": "10001234",
                    "name": "Trafo 1",
                    "spannungsebene": "20 kV",
                }
            ]
        }
    )


class MeasurementTypeResponse(BaseModel):
    type: str = Field(..., description="FDWH measurement type, e.g. P/Q/S/U/I")
    unit: str = Field(..., description="Display unit used by dashboard charts")

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {"type": "P", "unit": "MW"},
                {"type": "Q", "unit": "Mvar"},
            ]
        }
    )


# --- Measurements ---
class TimeseriesPoint(BaseModel):
    timestamp: datetime
    value: float

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [{"timestamp": "2026-06-01T00:15:00", "value": 12.483}]
        }
    )


class AggregationMethod(str, Enum):
    AVG = "AVG"
    MIN = "MIN"
    MAX = "MAX"
    SUM = "SUM"


class MeasurementMeta(BaseModel):
    """Self-describing provenance for every measurement response.

    The dashboard must always be able to tell — without guessing — whether
    it is looking at native-resolution raw data or user-requested
    aggregation. These fields are set as literals on the raw path and from
    the requested bucket/method on the aggregate path; they are never
    computed by a hidden heuristic.
    """

    is_raw: bool
    downsampled: bool
    aggregation_method: Optional[AggregationMethod] = None
    bucket_seconds: Optional[int] = None
    native_resolution_seconds: int
    point_count: int
    source: Literal["oracle", "duckdb"] = "oracle"
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    request_id: Optional[str] = None

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "is_raw": True,
                    "downsampled": False,
                    "aggregation_method": None,
                    "bucket_seconds": None,
                    "native_resolution_seconds": 900,
                    "point_count": 96,
                    "source": "oracle",
                    "start": "2026-06-01T00:00:00",
                    "end": "2026-06-02T00:00:00",
                    "request_id": "01JZ7E2K4F9T4MX9WPK2W1QX1E",
                }
            ]
        }
    )


class RawTimeseriesResponse(BaseModel):
    """Native-resolution measurements. Never aggregated or downsampled."""

    component_id: str
    component_name: str
    measurement_type: str
    unit: str
    data: list[TimeseriesPoint]
    # Set when the result was paginated; None means this is the last page.
    next_cursor: Optional[str] = None
    meta: MeasurementMeta

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "component_id": "10001234_020",
                    "component_name": "Trafo 1",
                    "measurement_type": "P",
                    "unit": "MW",
                    "data": [
                        {"timestamp": "2026-06-01T00:00:00", "value": 11.82},
                        {"timestamp": "2026-06-01T00:15:00", "value": 12.04},
                    ],
                    "next_cursor": "2026-06-01 00:15:00",
                    "meta": {
                        "is_raw": True,
                        "downsampled": False,
                        "aggregation_method": None,
                        "bucket_seconds": None,
                        "native_resolution_seconds": 900,
                        "point_count": 2,
                        "source": "oracle",
                        "start": "2026-06-01T00:00:00",
                        "end": "2026-06-02T00:00:00",
                    },
                }
            ]
        }
    )


class AggregatedTimeseriesResponse(BaseModel):
    """Explicitly user-requested aggregation over a fixed bucket."""

    component_id: str
    component_name: str
    measurement_type: str
    unit: str
    data: list[TimeseriesPoint]
    meta: MeasurementMeta

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "component_id": "10001234_020",
                    "component_name": "Trafo 1",
                    "measurement_type": "P",
                    "unit": "MW",
                    "data": [
                        {"timestamp": "2026-06-01T00:00:00", "value": 12.12},
                        {"timestamp": "2026-06-01T01:00:00", "value": 12.31},
                    ],
                    "meta": {
                        "is_raw": False,
                        "downsampled": True,
                        "aggregation_method": "AVG",
                        "bucket_seconds": 3600,
                        "native_resolution_seconds": 900,
                        "point_count": 2,
                        "source": "oracle",
                        "start": "2026-06-01T00:00:00",
                        "end": "2026-06-02T00:00:00",
                    },
                }
            ]
        }
    )


class AggregationResolutionResponse(BaseModel):
    seconds: int = Field(..., description="Bucket width in seconds")
    label: str = Field(..., description="German UI label")

    model_config = ConfigDict(
        json_schema_extra={"examples": [{"seconds": 3600, "label": "1 Stunde"}]}
    )


class DateRangeResponse(BaseModel):
    min_date: Optional[str] = Field(None, description="Earliest local date with data, YYYY-MM-DD")
    max_date: Optional[str] = Field(None, description="Latest local date with data, YYYY-MM-DD")

    model_config = ConfigDict(
        json_schema_extra={"examples": [{"min_date": "2025-01-01", "max_date": "2026-07-01"}]}
    )


class PointCountResponse(BaseModel):
    count: int = Field(..., ge=0, description="Number of native measurement points in the requested window")

    model_config = ConfigDict(json_schema_extra={"examples": [{"count": 2880}]})


class StatisticsResponse(BaseModel):
    component_name: str
    measurement_type: str
    unit: str
    count: int
    mean: float
    min: float
    max: float
    std_dev: Optional[float]


# --- Analytics ---
class HeatmapCell(BaseModel):
    day_of_week: int
    hour: int
    value: float

class HeatmapResponse(BaseModel):
    component_name: str
    measurement_type: str
    unit: str
    data: list[HeatmapCell]


class BandPoint(BaseModel):
    timestamp: datetime
    min: float
    mean: float
    max: float

class VoltageBandResponse(BaseModel):
    component_name: str
    unit: str
    weekday: list[BandPoint]
    weekend: list[BandPoint]


class DurationCurvePoint(BaseModel):
    percent: float
    value: float

class DurationCurveResponse(BaseModel):
    component_name: str
    measurement_type: str
    unit: str
    data: list[DurationCurvePoint]


class DailyProfilePoint(BaseModel):
    hour: float
    value: float
    std_dev: Optional[float] = None

class DailyProfileResponse(BaseModel):
    component_name: str
    measurement_type: str
    unit: str
    weekday_avg: list[DailyProfilePoint]
    weekend_avg: list[DailyProfilePoint]


# --- Correlation ---
class CorrelationPoint(BaseModel):
    x: float
    y: float

class CorrelationScatterResponse(BaseModel):
    component_name: str
    type_x: str
    unit_x: str
    type_y: str
    unit_y: str
    correlation: float
    # 0 means "no shift, X and Y compared at the same timestamps".
    # Positive: Y leads X by this many minutes. Negative: Y lags X.
    lag_minutes: int = 0
    # Short German interpretation hint derived from |r| + sign + types.
    interpretation: str = ""
    data: list[CorrelationPoint]

class CorrelationMatrixResponse(BaseModel):
    component_name: str
    types: list[str]
    units: list[str]
    # Cells may be None when no correlation is available for that pair.
    matrix: list[list[Optional[float]]]


# --- Box-Plot ---
class BoxPlotItem(BaseModel):
    label: str
    min: float
    q1: float
    median: float
    q3: float
    max: float

class BoxPlotResponse(BaseModel):
    component_name: str
    measurement_type: str
    unit: str
    # Echoes the requested bucketing so the frontend can label the x-axis
    # correctly without re-deriving it: 'hour' | 'weekday' | 'month' | 'weekday_weekend'.
    group_by: str = "hour"
    items: list[BoxPlotItem]


# --- Power Factor ---
class PowerFactorPoint(BaseModel):
    timestamp: datetime
    cos_phi: Optional[float] = None
    tan_phi: Optional[float] = None
    p: Optional[float] = None
    q: Optional[float] = None
    s: Optional[float] = None

class PowerFactorResponse(BaseModel):
    component_name: str
    data: list[PowerFactorPoint]
    histogram_bins: list[float]
    histogram_counts: list[int]

# --- Quality View ---
class QualityDayCount(BaseModel):
    day: str
    measurement_type: str
    count: int
    expected: int
    missing_pct: float

class QualityGapCell(BaseModel):
    day: str
    hour: int
    measurement_type: str
    count: int

class QualityResponse(BaseModel):
    component_name: str
    daily_counts: list[QualityDayCount]
    gap_heatmap: list[QualityGapCell]
    measurement_types: list[str]

# --- DST Double Hours ---
class DSTEvent(BaseModel):
    date: str
    type: str
    affected_hour: int
    measurement_count: int

class DSTResponse(BaseModel):
    component_name: str
    events: list[DSTEvent]

# --- Season Radar ---
class SeasonRadarSeries(BaseModel):
    measurement_type: str
    unit: str
    monthly_medians: list[float]

class SeasonRadarResponse(BaseModel):
    component_name: str
    months: list[str]
    series: list[SeasonRadarSeries]

# --- Exceedance Analysis ---
class ExceedanceDay(BaseModel):
    day: str
    minutes_above: float
    max_value: float
    mean_value: float

class ExceedanceResponse(BaseModel):
    component_name: str
    measurement_type: str
    unit: str
    threshold: float
    total_minutes_above: float
    total_pct: float
    top_days: list[ExceedanceDay]
