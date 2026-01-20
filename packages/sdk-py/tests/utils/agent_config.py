"""Agent Configuration Factory

Creates agent configs based on TEST_AGENT_TYPE environment variable.
If TEST_AGENT_TYPE is empty, returns None to let Evolve resolve from env.
Supports: codex, claude, gemini, qwen
"""

import os
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from evolve import AgentConfig, AgentType

# Load .env from workspace root (four levels up from tests/utils/)
root_dir = Path(__file__).parent.parent.parent.parent.parent
env_file = root_dir / '.env'
if env_file.exists():
    load_dotenv(env_file)


def get_agent_config() -> Optional[AgentConfig]:
    """Get agent configuration based on TEST_AGENT_TYPE environment variable.

    Returns None if TEST_AGENT_TYPE is not set, letting Evolve resolve from env.

    Returns:
        Optional[AgentConfig]: Configuration for the specified agent type, or None
    """
    agent_type = os.getenv('TEST_AGENT_TYPE')
    if not agent_type:
        return None  # Let Evolve resolve from env

    evolve_api_key = os.getenv('EVOLVE_API_KEY')
    if not evolve_api_key:
        raise ValueError(
            "EVOLVE_API_KEY is required. Get one from https://dashboard.evolvingmachines.ai"
            "and add EVOLVE_API_KEY=sk-... to your .env file."
        )

    if agent_type == 'codex':
        return AgentConfig(
            type='codex',
            api_key=evolve_api_key,
            model=os.getenv('CODEX_MODEL', 'gpt-5-codex'),
            reasoning_effort=os.getenv('CODEX_REASONING_EFFORT', 'medium'),
        )

    elif agent_type == 'claude':
        return AgentConfig(
            type='claude',
            api_key=evolve_api_key,
            model=os.getenv('ANTHROPIC_MODEL', 'claude-sonnet-4-5-20250929'),
        )

    elif agent_type == 'gemini':
        return AgentConfig(
            type='gemini',
            api_key=evolve_api_key,
            model=os.getenv('GEMINI_MODEL', 'gemini-2.5-flash'),
        )

    elif agent_type == 'qwen':
        return AgentConfig(
            type='qwen',
            api_key=evolve_api_key,
            model=os.getenv('QWEN_MODEL', 'qwen3-coder-plus'),
        )

    else:
        raise ValueError(f"Unsupported agent type: {agent_type}")


def get_agent_display_name(agent_type: AgentType) -> str:
    """Get agent display name for logging.

    Args:
        agent_type: Agent type

    Returns:
        str: Human-readable agent name
    """
    names = {
        'codex': 'Codex',
        'claude': 'Claude',
        'gemini': 'Gemini',
        'qwen': 'Qwen',
    }
    return names.get(agent_type, agent_type)


def validate_agent_config(config: Optional[AgentConfig]) -> None:
    """Validate agent configuration has required credentials.

    Args:
        config: Agent configuration (None means Evolve resolves from env)

    Raises:
        ValueError: If required credentials are missing
    """
    if config is None:
        return  # Evolve will resolve from env
    if not config.api_key:
        agent_name = get_agent_display_name(config.type)
        raise ValueError(
            f"{agent_name} requires EVOLVE_API_KEY environment variable "
            "(single key for all providers)."
        )
