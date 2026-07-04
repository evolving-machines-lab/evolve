import { DEFAULT_DASHBOARD_URL } from "./constants";
import type { AgentRegistryEntry } from "./registry";

export interface ManagedSecretRef {
  name: string;
  as?: string;
}

export interface ManagedSecretMetadata {
  id: string;
  name: string;
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  allowedMethods: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ManagedSecretsClientConfig {
  apiKey?: string;
  dashboardUrl?: string;
}

export interface ManagedSecretsClient {
  list(): Promise<ManagedSecretMetadata[]>;
}

export interface ManagedSecretRuntimeToken {
  token: string;
  bindingSecret: string;
  egressUrl: string;
  channelUrl: string;
  expiresAt: string;
  env: Array<{
    name: string;
    envName: string;
    placeholder: string;
    allowedHosts: string[];
  }>;
}

export const MANAGED_SECRET_BINDING_HEADER =
  "x-evolve-managed-secret-binding";
export const MANAGED_SECRET_CHANNEL_HEADER =
  "x-evolve-managed-secret-channel";
export const MANAGED_SECRET_TOKEN_HEADER = "x-evolve-managed-secret-token";
export const MANAGED_SECRET_PROXY_PORT = 18181;
export const MANAGED_SECRET_PROXY_DIR = "/tmp/evolve-managed-secrets";
export const MANAGED_SECRET_PROXY_SCRIPT_PATH =
  `${MANAGED_SECRET_PROXY_DIR}/proxy.py`;
export const MANAGED_SECRET_PROXY_CONFIG_PATH =
  `${MANAGED_SECRET_PROXY_DIR}/config.json`;
export const MANAGED_SECRET_CA_CERT_PATH =
  `${MANAGED_SECRET_PROXY_DIR}/ca.crt`;
export const MANAGED_SECRET_CA_KEY_PATH =
  `${MANAGED_SECRET_PROXY_DIR}/ca.key`;
export const MANAGED_SECRET_CA_BUNDLE_PATH =
  `${MANAGED_SECRET_PROXY_DIR}/ca-bundle.crt`;

const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];

export function managedSecretProxyEnvNames(): string[] {
  return [...PROXY_ENV_NAMES];
}

export const MANAGED_SECRET_PROXY_SCRIPT = String.raw`#!/usr/bin/env python3
import base64
import json
import os
import select
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
    os.environ.pop(key, None)

CONFIG_PATH = sys.argv[1]
with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    CONFIG = json.load(f)
try:
    os.unlink(CONFIG_PATH)
except FileNotFoundError:
    pass

MAX_BODY_BYTES = int(CONFIG.get("max_body_bytes", 10 * 1024 * 1024))
CONNECT_TIMEOUT_SECONDS = 15
SOCKET_TIMEOUT_SECONDS = 130
MAX_WORKERS = 100
WORKERS = threading.BoundedSemaphore(MAX_WORKERS)
HOST_PATTERNS = [h.lower() for h in CONFIG["hosts"]]
PLACEHOLDERS = set(CONFIG["placeholders"])
PLACEHOLDER_BYTES = [p.encode("utf-8") for p in CONFIG["placeholders"]]
BASE_DIR = CONFIG["base_dir"]
CERT_DIR = os.path.join(BASE_DIR, "certs")
os.makedirs(CERT_DIR, exist_ok=True)
CHANNEL_SECRET = secrets.token_urlsafe(32)

def register_channel():
    payload = json.dumps({}).encode("utf-8")
    req = urllib.request.Request(
        CONFIG["channel_url"],
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "x-evolve-managed-secret-token": CONFIG["token"],
            "x-evolve-managed-secret-binding": CONFIG["binding"],
            "x-evolve-managed-secret-channel": CHANNEL_SECRET,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status < 200 or resp.status >= 300:
            raise RuntimeError("managed secret channel registration failed")

def host_matches(pattern, host):
    host = host.lower()
    if pattern.startswith("*."):
        base = pattern[2:]
        return host != base and host.endswith("." + base)
    return host == pattern

def is_managed_host(host):
    clean = host.split(":", 1)[0].strip("[]").lower()
    return any(host_matches(pattern, clean) for pattern in HOST_PATTERNS)

def safe_name(host):
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in host)[:180]

def ensure_cert(host):
    name = safe_name(host)
    cert = os.path.join(CERT_DIR, name + ".crt")
    key = os.path.join(CERT_DIR, name + ".key")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    csr = os.path.join(CERT_DIR, name + ".csr")
    ext = os.path.join(CERT_DIR, name + ".ext")
    san = "IP:" + host if host.replace(".", "").isdigit() else "DNS:" + host
    with open(ext, "w", encoding="utf-8") as f:
        f.write("basicConstraints=critical,CA:FALSE\n")
        f.write("keyUsage=critical,digitalSignature,keyEncipherment\n")
        f.write("subjectAltName=" + san + "\n")
        f.write("extendedKeyUsage=serverAuth\n")
    subprocess.run(
        ["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-subj", "/CN=" + host, "-out", csr],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        [
            "openssl", "x509", "-req", "-in", csr,
            "-CA", CONFIG["ca_cert"], "-CAkey", CONFIG["ca_key"], "-CAcreateserial",
            "-out", cert, "-days", "30", "-sha256", "-extfile", ext,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return cert, key

def pipe_raw(client, host, port):
    upstream = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_SECONDS)
    client.settimeout(SOCKET_TIMEOUT_SECONDS)
    upstream.settimeout(SOCKET_TIMEOUT_SECONDS)
    try:
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        sockets = [client, upstream]
        while True:
            readable, _, _ = select.select(sockets, [], [], 120)
            if not readable:
                break
            for sock in readable:
                data = sock.recv(65536)
                if not data:
                    return
                (upstream if sock is client else client).sendall(data)
    finally:
        upstream.close()

def recv_until(sock, marker, limit=65536):
    data = b""
    while marker not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
        if len(data) > limit:
            raise RuntimeError("request headers too large")
    return data

def parse_headers(blob):
    head, rest = blob.split(b"\r\n\r\n", 1)
    lines = head.decode("iso-8859-1").split("\r\n")
    request_line = lines[0]
    headers = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip()] = value.strip()
    return request_line, headers, rest

def header_value(headers, name):
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return None

def read_chunked_body(sock, initial):
    data = initial
    body = b""
    while True:
        while b"\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("incomplete chunked request")
            data += chunk
        line, data = data.split(b"\r\n", 1)
        size = int((line.split(b";", 1)[0].strip() or b"0"), 16)
        if size == 0:
            return body
        if len(body) + size > MAX_BODY_BYTES:
            raise RuntimeError("request body too large")
        while len(data) < size + 2:
            chunk = sock.recv(65536)
            if not chunk:
                raise RuntimeError("incomplete chunked request")
            data += chunk
        body += data[:size]
        data = data[size + 2:]

def read_request(tls_sock):
    blob = recv_until(tls_sock, b"\r\n\r\n")
    if not blob:
        return None
    request_line, headers, rest = parse_headers(blob)
    transfer_encoding = (header_value(headers, "Transfer-Encoding") or "").lower()
    if "chunked" in transfer_encoding:
        return request_line, headers, read_chunked_body(tls_sock, rest)
    length = int(header_value(headers, "Content-Length") or "0")
    if length > MAX_BODY_BYTES:
        raise RuntimeError("request body too large")
    body = rest
    while len(body) < length:
        chunk = tls_sock.recv(min(65536, length - len(body)))
        if not chunk:
            break
        body += chunk
    return request_line, headers, body[:length]

def uses_placeholder(path, headers, body):
    if any(ph in path for ph in PLACEHOLDERS):
        return True
    if any(ph in value for ph in PLACEHOLDERS for value in headers.values()):
        return True
    return any(ph_b in body for ph_b in PLACEHOLDER_BYTES)

def call_dashboard(method, url, headers, body):
    payload = json.dumps({
        "method": method,
        "url": url,
        "headers": headers,
        "bodyBase64": base64.b64encode(body).decode("ascii") if body else "",
    }).encode("utf-8")
    req = urllib.request.Request(
        CONFIG["egress_url"],
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "x-evolve-managed-secret-token": CONFIG["token"],
            "x-evolve-managed-secret-binding": CONFIG["binding"],
            "x-evolve-managed-secret-channel": CHANNEL_SECRET,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=130) as resp:
            return resp.status, resp.reason, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        return err.code, "Managed Secret Egress Error", {"headers": {"content-type": "application/json"}, "bodyBase64": base64.b64encode(text.encode()).decode("ascii")}

def read_limited_response(stream):
    chunks = []
    total = 0
    while True:
        chunk = stream.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise RuntimeError("response body too large")
        chunks.append(chunk)
    return b"".join(chunks)

def call_direct(method, url, headers, body):
    hop_by_hop = {"connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"}
    request_headers = {k: v for k, v in headers.items() if k.lower() not in hop_by_hop}
    req = urllib.request.Request(
        url,
        data=body if body else None,
        method=method,
        headers=request_headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=130) as resp:
            return resp.status, resp.reason, {
                "headers": dict(resp.headers.items()),
                "bodyBase64": base64.b64encode(read_limited_response(resp)).decode("ascii"),
            }
    except urllib.error.HTTPError as err:
        return err.code, err.reason, {
            "headers": dict(err.headers.items()),
            "bodyBase64": base64.b64encode(read_limited_response(err)).decode("ascii"),
        }

def send_response(tls_sock, status, reason, result):
    body = base64.b64decode(result.get("bodyBase64") or "")
    headers = {str(k): str(v) for k, v in (result.get("headers") or {}).items()}
    headers["content-length"] = str(len(body))
    headers["connection"] = "close"
    status_line = ("HTTP/1.1 %d %s\r\n" % (status, reason or "")).encode("ascii", "replace")
    header_blob = b"".join((name + ": " + value + "\r\n").encode("iso-8859-1", "replace") for name, value in headers.items())
    tls_sock.sendall(status_line + header_blob + b"\r\n" + body)

def dispatch_managed_request(method, url, headers, body):
    if uses_placeholder(url, headers, body):
        return call_dashboard(method, url, headers, body)
    return call_direct(method, url, headers, body)

def handle_managed_connect(client, host, port):
    client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    cert, key = ensure_cert(host)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    client.settimeout(SOCKET_TIMEOUT_SECONDS)
    tls_sock = ctx.wrap_socket(client, server_side=True)
    tls_sock.settimeout(SOCKET_TIMEOUT_SECONDS)
    try:
        request = read_request(tls_sock)
        if not request:
            return
        request_line, headers, body = request
        parts = request_line.split()
        if len(parts) < 2:
            raise RuntimeError("bad request line")
        method, path = parts[0].upper(), parts[1]
        if path.startswith("http://") or path.startswith("https://"):
            url = path
        else:
            url = "https://%s%s" % (host if port == 443 else host + ":" + str(port), path)
        status, reason, result = dispatch_managed_request(method, url, headers, body)
        send_response(tls_sock, status, reason, result)
    finally:
        try:
            tls_sock.close()
        except Exception:
            pass

def handle_client(client):
    try:
        client.settimeout(SOCKET_TIMEOUT_SECONDS)
        blob = recv_until(client, b"\r\n\r\n")
        if not blob:
            return
        request_line, headers, rest = parse_headers(blob)
        parts = request_line.split()
        if len(parts) < 3:
            return
        if parts[0].upper() == "CONNECT":
            target = parts[1]
            if ":" in target:
                host, port_s = target.rsplit(":", 1)
                port = int(port_s)
            else:
                host, port = target, 443
            host = host.strip("[]")
            if is_managed_host(host):
                handle_managed_connect(client, host, port)
            else:
                pipe_raw(client, host, port)
            return
        client.sendall(b"HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    except Exception as exc:
        try:
            body = json.dumps({"error": str(exc)}).encode("utf-8")
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: " + str(len(body)).encode() + b"\r\nconnection: close\r\n\r\n" + body)
        except Exception:
            pass
    finally:
        try:
            client.close()
        except Exception:
            pass

def serve():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", int(CONFIG["port"])))
    server.listen(100)
    while True:
        client, _ = server.accept()
        if not WORKERS.acquire(blocking=False):
            try:
                client.sendall(b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
            except Exception:
                pass
            client.close()
            continue
        def run_client():
            try:
                handle_client(client)
            finally:
                WORKERS.release()
        thread = threading.Thread(target=run_client, daemon=True)
        thread.start()

if __name__ == "__main__":
    register_channel()
    serve()
`;

function dashboardBaseUrl(url?: string): string {
  return (url || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

function requireApiKey(config: ManagedSecretsClientConfig): string {
  const apiKey = config.apiKey || process.env.EVOLVE_API_KEY;
  if (!apiKey) throw new Error("EVOLVE_API_KEY is required for managed secrets");
  return apiKey;
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

async function requestJson<T>(
  config: ManagedSecretsClientConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${dashboardBaseUrl(config.dashboardUrl)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireApiKey(config)}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Managed secrets request failed (${response.status}): ${await readError(response)}`);
  }
  return (await response.json()) as T;
}

export function managedSecrets(config: ManagedSecretsClientConfig = {}): ManagedSecretsClient {
  return {
    async list() {
      const result = await requestJson<{ secrets?: ManagedSecretMetadata[] }>(
        config,
        "/api/managed-secrets",
      );
      return result.secrets ?? [];
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isManagedSecretRuntimeToken(value: unknown): value is ManagedSecretRuntimeToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === "string" &&
    record.token.startsWith("evrt_") &&
    typeof record.bindingSecret === "string" &&
    record.bindingSecret.startsWith("evrb_") &&
    typeof record.egressUrl === "string" &&
    isHttpsUrl(record.egressUrl) &&
    typeof record.channelUrl === "string" &&
    isHttpsUrl(record.channelUrl) &&
    typeof record.expiresAt === "string" &&
    Array.isArray(record.env) &&
    record.env.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const env = item as Record<string, unknown>;
      return (
        typeof env.name === "string" &&
        typeof env.envName === "string" &&
        typeof env.placeholder === "string" &&
        env.placeholder.startsWith("evsec_") &&
        isStringArray(env.allowedHosts)
      );
    })
  );
}

export async function createManagedSecretRuntimeToken(
  config: Required<Pick<ManagedSecretsClientConfig, "apiKey">> & { dashboardUrl?: string },
  input: { sessionTag: string; secrets: ManagedSecretRef[] },
): Promise<ManagedSecretRuntimeToken> {
  const result = await requestJson<unknown>(
    config,
    "/api/managed-secrets/runtime-token",
    { method: "POST", body: JSON.stringify(input) },
  );
  if (!isManagedSecretRuntimeToken(result)) {
    throw new Error("Invalid managed secret runtime token response");
  }
  return result;
}

export async function bindManagedSecretRuntimeToken(
  config: Required<Pick<ManagedSecretsClientConfig, "apiKey">> & { dashboardUrl?: string },
  input: { token: string; sandboxId: string },
): Promise<boolean> {
  const result = await requestJson<{ ok: boolean }>(
    config,
    "/api/managed-secrets/runtime-token",
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.ok;
}

export async function revokeManagedSecretRuntimeToken(
  config: Required<Pick<ManagedSecretsClientConfig, "apiKey">> & { dashboardUrl?: string },
  input: { token: string },
): Promise<boolean> {
  const result = await requestJson<{ ok: boolean }>(
    config,
    "/api/managed-secrets/runtime-token",
    { method: "DELETE", body: JSON.stringify(input) },
  );
  return result.ok;
}

export function normalizeManagedSecretRefs(secrets: ManagedSecretRef[]): ManagedSecretRef[] {
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new Error("withManagedSecrets() requires at least one secret");
  }
  return secrets.map((secret, index) => {
    if (!secret || typeof secret !== "object" || Array.isArray(secret)) {
      throw new Error(`managedSecrets[${index}] must be an object with a name`);
    }
    const name = normalizeEnvName(secret.name, `managedSecrets[${index}].name`);
    const as = secret.as === undefined
      ? undefined
      : normalizeEnvName(secret.as, `managedSecrets[${index}].as`);
    return as ? { name, as } : { name };
  });
}

function normalizeEnvName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const name = value.trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) {
    throw new Error(`${field} must be a valid environment variable name`);
  }
  if (name.startsWith("EVOLVE_")) {
    throw new Error(`${field} cannot use the reserved EVOLVE_ prefix`);
  }
  return name;
}

export function managedSecretReservedEnvNames(registry: AgentRegistryEntry): Set<string> {
  const reserved = new Set<string>([
    "EVOLVE_API_KEY",
    "EVOLVE_PROVIDER_RUNTIME_BINDING",
    "GEMINI_DEFAULT_AUTH_TYPE",
    ...PROXY_ENV_NAMES,
  ]);
  const add = (value?: string) => {
    if (value) reserved.add(value);
  };
  add(registry.apiKeyEnv);
  add(registry.baseUrlEnv);
  add(registry.customHeadersEnv);
  add(registry.gatewayConfigEnv);
  if (registry.spendTrackingEnvs) {
    add(registry.spendTrackingEnvs.sessionTagEnv);
    add(registry.spendTrackingEnvs.runTagEnv);
  }
  for (const mapping of Object.values(registry.providerEnvMap ?? {})) {
    add(mapping.keyEnv);
  }
  return reserved;
}

export function validateManagedSecretRefsForRegistry(
  secrets: ManagedSecretRef[] | undefined,
  registry: AgentRegistryEntry,
): ManagedSecretRef[] | undefined {
  if (!secrets) return undefined;
  const normalized = normalizeManagedSecretRefs(secrets);
  const reserved = managedSecretReservedEnvNames(registry);
  const aliases = new Set<string>();
  for (const secret of normalized) {
    const envName = secret.as || secret.name;
    if (reserved.has(envName)) {
      throw new Error(`${envName} is reserved for Evolve-managed sandbox services and cannot be used as a managed secret env var`);
    }
    if (aliases.has(envName)) {
      throw new Error(`duplicate managed secret env var: ${envName}`);
    }
    aliases.add(envName);
  }
  return normalized;
}

export function managedSecretSandboxEnvs(token: ManagedSecretRuntimeToken): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const item of token.env) {
    envs[item.envName] = item.placeholder;
  }
  const proxy = `http://127.0.0.1:${MANAGED_SECRET_PROXY_PORT}`;
  envs.HTTPS_PROXY = proxy;
  envs.https_proxy = proxy;
  envs.NODE_EXTRA_CA_CERTS = MANAGED_SECRET_CA_CERT_PATH;
  envs.SSL_CERT_FILE = MANAGED_SECRET_CA_BUNDLE_PATH;
  envs.REQUESTS_CA_BUNDLE = MANAGED_SECRET_CA_BUNDLE_PATH;
  envs.CURL_CA_BUNDLE = MANAGED_SECRET_CA_BUNDLE_PATH;
  envs.GIT_SSL_CAINFO = MANAGED_SECRET_CA_BUNDLE_PATH;
  const dashboardHost = new URL(token.egressUrl).hostname;
  envs.NO_PROXY = `localhost,127.0.0.1,::1,${dashboardHost}`;
  envs.no_proxy = envs.NO_PROXY;
  return envs;
}

export function managedSecretProxyConfig(token: ManagedSecretRuntimeToken): string {
  const hosts = Array.from(new Set(token.env.flatMap((item) => item.allowedHosts)));
  return JSON.stringify({
    egress_url: token.egressUrl,
    channel_url: token.channelUrl,
    token: token.token,
    binding: token.bindingSecret,
    hosts,
    placeholders: token.env.map((item) => item.placeholder),
    base_dir: MANAGED_SECRET_PROXY_DIR,
    ca_cert: MANAGED_SECRET_CA_CERT_PATH,
    ca_key: MANAGED_SECRET_CA_KEY_PATH,
    port: MANAGED_SECRET_PROXY_PORT,
    max_body_bytes: 10 * 1024 * 1024,
  }, null, 2);
}

export function managedSecretCaSetupCommand(): string {
  return [
    `umask 077`,
    `mkdir -p ${MANAGED_SECRET_PROXY_DIR}/certs`,
    `chmod 700 ${MANAGED_SECRET_PROXY_DIR} ${MANAGED_SECRET_PROXY_DIR}/certs`,
    `chmod 700 ${MANAGED_SECRET_PROXY_SCRIPT_PATH} 2>/dev/null || true`,
    `chmod 600 ${MANAGED_SECRET_PROXY_CONFIG_PATH} 2>/dev/null || true`,
    `if [ ! -f ${MANAGED_SECRET_CA_KEY_PATH} ]; then openssl genrsa -out ${MANAGED_SECRET_CA_KEY_PATH} 2048 >/dev/null 2>&1; fi`,
    `if [ ! -f ${MANAGED_SECRET_CA_CERT_PATH} ]; then openssl req -x509 -new -nodes -key ${MANAGED_SECRET_CA_KEY_PATH} -sha256 -days 30 -subj "/CN=Evolve Managed Secrets" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ${MANAGED_SECRET_CA_CERT_PATH} >/dev/null 2>&1; fi`,
    `SYSTEM_CA_BUNDLE=""; for p in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem; do if [ -f "$p" ]; then SYSTEM_CA_BUNDLE="$p"; break; fi; done; if [ -n "$SYSTEM_CA_BUNDLE" ]; then cat "$SYSTEM_CA_BUNDLE" ${MANAGED_SECRET_CA_CERT_PATH} > ${MANAGED_SECRET_CA_BUNDLE_PATH}; else cp ${MANAGED_SECRET_CA_CERT_PATH} ${MANAGED_SECRET_CA_BUNDLE_PATH}; fi`,
    `if command -v update-ca-certificates >/dev/null 2>&1; then cp ${MANAGED_SECRET_CA_CERT_PATH} /usr/local/share/ca-certificates/evolve-managed-secrets.crt 2>/dev/null && update-ca-certificates >/dev/null 2>&1 || true; fi`,
  ].join(" && ");
}

export function managedSecretProxyStartCommand(): string {
  return `umask 077 && exec python3 ${MANAGED_SECRET_PROXY_SCRIPT_PATH} ${MANAGED_SECRET_PROXY_CONFIG_PATH}`;
}

export function managedSecretProxyConfigCleanupCommand(): string {
  return `rm -f ${MANAGED_SECRET_PROXY_CONFIG_PATH}`;
}
