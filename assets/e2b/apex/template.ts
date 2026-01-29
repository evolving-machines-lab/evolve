import { Template } from 'e2b'

// =============================================================================
// APEX Benchmark E2B Template
// =============================================================================
// Extends evolve-all with:
//   - MCP servers from Archipelago (mail, calendar, chat, docs, sheets, pdfs, slides)
//   - LibreOffice for document processing
//   - proot for sandboxed execution
//   - All 33 APEX worlds pre-cached from HuggingFace (~9GB)
//
// To rebuild: npx tsx assets/e2b/apex/build.ts
// =============================================================================

export const template = Template()

  // ---------------------------------------------------------------------------
  // Base: Evolve template with all AI CLIs
  // ---------------------------------------------------------------------------
  .fromImage('evolve-all')

  // ---------------------------------------------------------------------------
  // System packages (as root)
  // ---------------------------------------------------------------------------
  .setUser('root')
  .setWorkdir('/')

  // LibreOffice for spreadsheet/document processing + proot for sandboxed execution
  .runCmd('apt-get update && apt-get install -y libreoffice-calc libreoffice-core proot zip unzip && rm -rf /var/lib/apt/lists/*')

  // ---------------------------------------------------------------------------
  // MCP Servers from Archipelago
  // ---------------------------------------------------------------------------
  // Clone only the mcp_servers directory (sparse checkout)
  .runCmd(`
    git clone --depth 1 --filter=blob:none --sparse https://github.com/Mercor-Intelligence/archipelago.git /tmp/archipelago &&
    cd /tmp/archipelago &&
    git sparse-checkout set mcp_servers &&
    mkdir -p /opt/mcp &&
    mv mcp_servers/mail /opt/mcp/ &&
    mv mcp_servers/calendar /opt/mcp/ &&
    mv mcp_servers/chat /opt/mcp/ &&
    mv mcp_servers/documents /opt/mcp/ &&
    mv mcp_servers/spreadsheets /opt/mcp/ &&
    mv mcp_servers/pdfs /opt/mcp/ &&
    mv mcp_servers/presentations /opt/mcp/ &&
    rm -rf /tmp/archipelago
  `.replace(/\n\s+/g, ' ').trim())

  // Install dependencies for each MCP server
  .runCmd('cd /opt/mcp/mail && uv sync --all-extras')
  .runCmd('cd /opt/mcp/calendar && uv sync --all-extras')
  .runCmd('cd /opt/mcp/chat && uv sync --all-extras')
  .runCmd('cd /opt/mcp/documents && uv sync --all-extras')
  .runCmd('cd /opt/mcp/spreadsheets && uv sync --all-extras')
  .runCmd('cd /opt/mcp/pdfs && uv sync --all-extras')
  .runCmd('cd /opt/mcp/presentations && uv sync --all-extras')

  // ---------------------------------------------------------------------------
  // Apps Data Directories (for MCP server state)
  // ---------------------------------------------------------------------------
  .runCmd('mkdir -p /.apps_data/mail /.apps_data/calendar /.apps_data/chat')
  .runCmd('chmod -R 777 /.apps_data')

  // ---------------------------------------------------------------------------
  // Pre-cache APEX Worlds from HuggingFace (~9GB)
  // ---------------------------------------------------------------------------
  .runCmd('mkdir -p /opt/apex/worlds')

  // Install huggingface_hub for downloading
  .runCmd('uv pip install --system huggingface_hub datasets')

  // Download all world files from HuggingFace dataset
  .runCmd(`python3 -c "
from huggingface_hub import snapshot_download
import os

# Download the entire dataset including world files
snapshot_download(
    'mercor/apex-agents',
    repo_type='dataset',
    local_dir='/opt/apex/dataset',
    allow_patterns=['world_files_zipped/*'],
)
print('Downloaded all APEX worlds')
"`)

  // ---------------------------------------------------------------------------
  // Create workspace structure
  // ---------------------------------------------------------------------------
  .setUser('user')
  .setWorkdir('/home/user')

  .runCmd('mkdir -p /home/user/workspace/context /home/user/workspace/output')

  // ---------------------------------------------------------------------------
  // Verify installation
  // ---------------------------------------------------------------------------
  .runCmd('ls -la /opt/mcp/')
  .runCmd('ls -la /opt/apex/dataset/world_files_zipped/ | head -20')
