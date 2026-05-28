"""Standalone browser credentials client."""

import asyncio
import base64
import hashlib
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from .config import BrowserCredentialsClientConfig


DEFAULT_DASHBOARD_URL = 'https://dashboard.evolvingmachines.ai'
BROWSER_AUTH_ALGORITHM = 'RSA-OAEP-256'


@dataclass
class BrowserCredentialMetadata:
    id: str
    website: str
    account_label: str
    email: str
    enabled: bool
    created_by: str
    created_at: str
    updated_at: str
    last_used_at: Optional[str]


@dataclass
class BrowserCredentialsPage:
    credentials: List[BrowserCredentialMetadata]
    total: int
    count: int
    offset: int
    has_more: bool


def _metadata_from_dict(data: Dict[str, Any]) -> BrowserCredentialMetadata:
    return BrowserCredentialMetadata(
        id=data['id'],
        website=data['website'],
        account_label=data['account_label'],
        email=data['email'],
        enabled=bool(data.get('enabled', True)),
        created_by=data.get('createdBy') or data.get('created_by') or 'user',
        created_at=data.get('createdAt') or data.get('created_at') or '',
        updated_at=data.get('updatedAt') or data.get('updated_at') or '',
        last_used_at=data.get('lastUsedAt') or data.get('last_used_at'),
    )


class BrowserCredentialsClient:
    """List, create, and delete saved browser logins without returning passwords."""

    def __init__(
        self,
        config: Optional[BrowserCredentialsClientConfig] = None,
    ):
        self.config = config or BrowserCredentialsClientConfig()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    async def close(self):
        return None

    async def list(
        self,
        website: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> BrowserCredentialsPage:
        params = {}
        if website is not None:
            params['website'] = website
        if limit is not None:
            params['limit'] = str(limit)
        if offset is not None:
            params['offset'] = str(offset)
        query = urllib.parse.urlencode(params)
        result = await self._request_json(f'/api/browser-credentials{("?" + query) if query else ""}')
        credentials = [_metadata_from_dict(item) for item in result.get('credentials', [])]
        return BrowserCredentialsPage(
            credentials=credentials,
            total=int(result.get('total', len(credentials))),
            count=int(result.get('count', len(credentials))),
            offset=int(result.get('offset', offset or 0)),
            has_more=bool(result.get('hasMore', result.get('has_more', False))),
        )

    async def create(
        self,
        *,
        website: str,
        account_label: str,
        email: str,
        password: str,
    ) -> Dict[str, Any]:
        encrypted_password = await self._encrypt_password(password)
        result = await self._request_json('/api/browser-credentials', method='POST', body={
            'website': website,
            'account_label': account_label,
            'email': email,
            'encryptedPassword': encrypted_password,
        })
        return {
            'status': result['status'],
            'credential': _metadata_from_dict(result['credential']),
        }

    async def delete(
        self,
        *,
        id: Optional[str] = None,
        website: Optional[str] = None,
        account_label: Optional[str] = None,
    ) -> Dict[str, bool]:
        if id:
            body = {'id': id}
        elif website and account_label:
            body = {'website': website, 'account_label': account_label}
        else:
            raise ValueError('delete requires either id or website and account_label')
        return await self._request_json('/api/browser-credentials', method='DELETE', body=body)

    async def _encrypt_password(self, password: str) -> Dict[str, str]:
        key = await self._request_json('/api/browser-credentials/public-key')
        if key.get('algorithm') != BROWSER_AUTH_ALGORITHM:
            raise ValueError('Unsupported browser credential encryption algorithm')
        ciphertext = _rsa_oaep_sha256_encrypt(key['publicKey'], password.encode('utf-8'))
        return {
            'algorithm': BROWSER_AUTH_ALGORITHM,
            'keyId': key['id'],
            'ciphertext': _base64url(ciphertext),
        }

    async def _request_json(
        self,
        path: str,
        method: str = 'GET',
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await asyncio.to_thread(self._request_json_sync, path, method, body)

    def _request_json_sync(
        self,
        path: str,
        method: str,
        body: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        data = json.dumps(body).encode('utf-8') if body is not None else None
        headers = {
            'Authorization': f'Bearer {_resolve_api_key(self.config)}',
            'Accept': 'application/json',
        }
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(
            f'{_dashboard_base_url(self.config)}{path}',
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read().decode('utf-8')
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'Browser credentials request failed ({exc.code}): {detail}') from exc
        if not payload:
            return {}
        return json.loads(payload)


def _dashboard_base_url(config: BrowserCredentialsClientConfig) -> str:
    return (config.dashboard_url or os.environ.get('EVOLVE_DASHBOARD_URL') or DEFAULT_DASHBOARD_URL).rstrip('/')


def _resolve_api_key(config: BrowserCredentialsClientConfig) -> str:
    api_key = config.api_key or os.environ.get('EVOLVE_API_KEY')
    if not api_key:
        raise ValueError('Browser credentials require EVOLVE_API_KEY or BrowserCredentialsClientConfig(api_key=...)')
    return api_key


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def _read_der_length(data: bytes, offset: int) -> Tuple[int, int]:
    first = data[offset]
    offset += 1
    if first < 0x80:
        return first, offset
    count = first & 0x7F
    if count == 0 or count > 4:
        raise ValueError('Unsupported DER length')
    length = int.from_bytes(data[offset:offset + count], 'big')
    return length, offset + count


def _read_der_tlv(data: bytes, offset: int, expected_tag: int) -> Tuple[bytes, int]:
    if offset >= len(data) or data[offset] != expected_tag:
        raise ValueError('Unexpected public key format')
    length, value_start = _read_der_length(data, offset + 1)
    value_end = value_start + length
    if value_end > len(data):
        raise ValueError('Invalid public key length')
    return data[value_start:value_end], value_end


def _parse_rsa_public_key(pem: str) -> Tuple[int, int, int]:
    body = ''.join(
        line.strip()
        for line in pem.splitlines()
        if line and not line.startswith('-----')
    )
    der = base64.b64decode(body)
    spki, offset = _read_der_tlv(der, 0, 0x30)
    if offset != len(der):
        raise ValueError('Unexpected trailing public key data')
    _, offset = _read_der_tlv(spki, 0, 0x30)
    bit_string, offset = _read_der_tlv(spki, offset, 0x03)
    if offset != len(spki) or not bit_string or bit_string[0] != 0:
        raise ValueError('Invalid RSA public key')
    rsa_key, offset = _read_der_tlv(bit_string[1:], 0, 0x30)
    if offset != len(bit_string) - 1:
        raise ValueError('Unexpected RSA key data')
    modulus_bytes, offset = _read_der_tlv(rsa_key, 0, 0x02)
    exponent_bytes, offset = _read_der_tlv(rsa_key, offset, 0x02)
    if offset != len(rsa_key):
        raise ValueError('Unexpected RSA integer data')
    n = int.from_bytes(modulus_bytes.lstrip(b'\x00'), 'big')
    e = int.from_bytes(exponent_bytes, 'big')
    k = (n.bit_length() + 7) // 8
    return n, e, k


def _mgf1(seed: bytes, length: int) -> bytes:
    output = bytearray()
    counter = 0
    while len(output) < length:
        output.extend(hashlib.sha256(seed + counter.to_bytes(4, 'big')).digest())
        counter += 1
    return bytes(output[:length])


def _xor_bytes(left: bytes, right: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(left, right))


def _rsa_oaep_sha256_encrypt(public_key_pem: str, plaintext: bytes) -> bytes:
    n, e, k = _parse_rsa_public_key(public_key_pem)
    h_len = hashlib.sha256().digest_size
    if len(plaintext) > k - 2 * h_len - 2:
        raise ValueError('Browser credential password is too long for RSA-OAEP-256')

    label_hash = hashlib.sha256(b'').digest()
    padding = b'\x00' * (k - len(plaintext) - 2 * h_len - 2)
    data_block = label_hash + padding + b'\x01' + plaintext
    seed = secrets.token_bytes(h_len)
    masked_data_block = _xor_bytes(data_block, _mgf1(seed, k - h_len - 1))
    masked_seed = _xor_bytes(seed, _mgf1(masked_data_block, h_len))
    encoded = b'\x00' + masked_seed + masked_data_block
    cipher_int = pow(int.from_bytes(encoded, 'big'), e, n)
    return cipher_int.to_bytes(k, 'big')
