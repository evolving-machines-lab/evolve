"""Schema utilities for Pydantic models, dataclasses, and JSON Schema.

Provides unified detection, conversion, and validation for schema types.
Uses Pydantic's TypeAdapter for dataclass support.
"""

import dataclasses
from typing import Any, Dict, Optional


# =============================================================================
# DETECTION
# =============================================================================


def is_pydantic_model(obj: Any) -> bool:
    """Check if object is a Pydantic model class."""
    try:
        from pydantic import BaseModel
        return isinstance(obj, type) and issubclass(obj, BaseModel)
    except ImportError:
        return False


def is_dataclass(obj: Any) -> bool:
    """Check if object is a dataclass."""
    return dataclasses.is_dataclass(obj) and isinstance(obj, type)


def is_json_schema(obj: Any) -> bool:
    """Check if object is a JSON Schema dict."""
    return isinstance(obj, dict)


# =============================================================================
# CONVERSION
# =============================================================================


def to_json_schema(schema: Any) -> Optional[Dict[str, Any]]:
    """Convert a schema to JSON Schema format.

    Supports:
    - Dict (JSON Schema) - passed through
    - Pydantic models - uses model_json_schema()
    - Dataclasses - uses Pydantic TypeAdapter

    Args:
        schema: Pydantic model, dataclass, or JSON Schema dict

    Returns:
        JSON Schema dict, or None if schema is None
    """
    if schema is None:
        return None

    if is_json_schema(schema):
        return schema

    if is_pydantic_model(schema):
        return schema.model_json_schema()

    if is_dataclass(schema):
        from pydantic import TypeAdapter
        return TypeAdapter(schema).json_schema()

    raise TypeError(
        f"Schema must be a Pydantic model, dataclass, or dict. "
        f"Got {type(schema).__name__}"
    )


# =============================================================================
# VALIDATION
# =============================================================================


def validate_and_parse(
    raw_json: str,
    schema: Any,
    strict: bool = False,
) -> Any:
    """Validate JSON string and parse into schema type.

    Args:
        raw_json: Raw JSON string to validate
        schema: Pydantic model or dataclass (returns instance)
        strict: Use strict validation mode

    Returns:
        Model/dataclass instance, or None for dict schemas

    Raises:
        ValidationError: If validation fails
    """
    if schema is None or is_json_schema(schema):
        # JSON Schema validation is handled by TS SDK
        return None

    if is_pydantic_model(schema):
        return schema.model_validate_json(raw_json, strict=strict)

    if is_dataclass(schema):
        from pydantic import TypeAdapter
        return TypeAdapter(schema).validate_json(raw_json, strict=strict)

    return None
