"""Read local .env without executing shell code. Environment has higher priority."""
import os
from pathlib import Path

def load_local_env():
    path = Path(__file__).resolve().parents[1] / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            if key in {'API_CONFIG_FILE','MODEL_API_KEY','MODEL_BASE_URL','MODEL_NAME','DATA_DIR','ALLOWED_ORIGINS','COOKIE_SECURE',
                       'AGENT_RUNTIME','AGENT_SDK_BASE_URL','TEST_ACCOUNT_PASSWORD',
                       'MEMORY_CONTEXT_TOKENS','MEMORY_CONTEXT_MAX_ITEMS','MEMORY_TOPIC_CONTEXT_TOKENS',
                       'MEMORY_CONSOLIDATION_ENABLED','MEMORY_CONSOLIDATE_SOURCES','MEMORY_CONSOLIDATE_TOKENS',
                       'MEMORY_CONSOLIDATE_INPUT_TOKENS','MEMORY_CONSOLIDATE_MAX_SOURCES','MEMORY_CONSOLIDATE_OUTPUT_TOKENS'}:
                os.environ.setdefault(key, value.strip().strip('\"\''))
