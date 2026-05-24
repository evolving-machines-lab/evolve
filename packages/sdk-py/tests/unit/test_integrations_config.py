"""Unit tests for managed integrations configuration."""

import pytest

from evolve import IntegrationsConfig, IntegrationsSetup


def test_integrations_setup_is_keyword_only():
    with pytest.raises(TypeError):
        IntegrationsSetup("root", ["gmail"])  # type: ignore[misc]


def test_integrations_setup_to_dict():
    setup = IntegrationsSetup(
        user_id="customer_123",
        apps=["gmail"],
        tools={"gmail": ["gmail_search_emails"]},
        accounts={"gmail": ["work"]},
    )

    assert setup.to_dict() == {
        "user_id": "customer_123",
        "apps": ["gmail"],
        "tools": {"gmail": ["gmail_search_emails"]},
        "accounts": {"gmail": ["work"]},
    }


def test_integrations_config_is_keyword_only():
    with pytest.raises(TypeError):
        IntegrationsConfig(["gmail"])  # type: ignore[misc]

