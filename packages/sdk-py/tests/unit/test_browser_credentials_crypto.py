"""The stdlib RSA-OAEP-SHA256 encryptor behind browser credentials.

A fixed RSA-2048 keypair is embedded so the round trip is decidable: encrypt
with the module under test, decrypt with the private exponent and an
INDEPENDENT OAEP unpadding written here — reusing the module's own MGF1 would
prove the code agrees with itself, not that it encrypts correctly.
"""

import hashlib

import pytest

from evolve.browser_credentials import (
    _parse_rsa_public_key,
    _rsa_oaep_sha256_encrypt,
    _xor_bytes,
)

# RSA-2048 test keypair (generated for these tests only — never used anywhere).
PUBLIC_PEM = (
    '-----BEGIN PUBLIC KEY-----\n'
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxIBpkwLihd5rIFsbcsNf\n'
    'WPwlFavQZTXY4ClnBFvcj4TlJWilPO28pmfxSsOAPuZzJ/ckJqBhiCcR5fzA2NBi\n'
    '8hwrjlTeHe9CjU0A68GcFd1wLDH86PSgtCHJwknAQB9XRTrv9oY2UFiPXpBgWx8e\n'
    'VCx9RnnNOoX45YyKGATWIgQENKK0/c+SlBt9CjxRkUTXbaZ4B2wvUGhgZypdCmNd\n'
    'UotM90wkkw4wy4Itv+3EnXKzSRc9w7W2pWul6NZPv40Gk1LjD0q2/pgin0yMoO/+\n'
    'c4WacJidzkq4ls7eFFWFVvfnyGEO0LvHyKYIWcl5k9+HTeTGgT0rxO3xN+6BZDTr\n'
    'wQIDAQAB\n'
    '-----END PUBLIC KEY-----\n'
)
N = int(
    'c480699302e285de6b205b1b72c35f58fc2515abd06535d8e02967045bdc8f84'
    'e52568a53cedbca667f14ac3803ee67327f72426a061882711e5fcc0d8d062f2'
    '1c2b8e54de1def428d4d00ebc19c15dd702c31fce8f4a0b421c9c249c0401f57'
    '453aeff6863650588f5e90605b1f1e542c7d4679cd3a85f8e58c8a1804d62204'
    '0434a2b4fdcf92941b7d0a3c519144d76da678076c2f506860672a5d0a635d52'
    '8b4cf74c24930e30cb822dbfedc49d72b349173dc3b5b6a56ba5e8d64fbf8d06'
    '9352e30f4ab6fe98229f4c8ca0effe73859a70989dce4ab896cede14558556f7'
    'e7c8610ed0bbc7c8a60859c97993df874de4c6813d2bc4edf137ee816434ebc1',
    16,
)
D = int(
    '347908b83b42fba08e017be81e835188d4fc4a31dc052040a3cb7fe39d6c3934'
    '5c6f303c9517f467de1b2f1879bca79404b8c301eae8b5e4f3ab48b819586709'
    '0ec0b57cb03baa27f42250a6a41d91867fc282d96de935537a2fadc992a4623a'
    '246b3d52703b3cc55eb3a53635df0a1da181153ac80a62bae3ac3336d56e7672'
    '72f18ab1521310b7b192be971df6827eb45e2595d160c3df7555910b26b9919b'
    '911fb75976e9ecb67ed1cae554797c0207c463117da1e9d5fcf0f034ab491c67'
    '8052524575698c4aad4c35c43836560ff7781255ac669ab642a631948ece1b5b'
    'f2d36765d9ada331447a70b37633fb2fcc0540559d71d473b6b51f9bcfbee61',
    16,
)
K = 256  # modulus length in bytes


def _mgf1_independent(seed: bytes, length: int) -> bytes:
    out = b''
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(seed + counter.to_bytes(4, 'big')).digest()
        counter += 1
    return out[:length]


def _oaep_decrypt(ciphertext: bytes) -> bytes:
    """RFC 8017 RSAES-OAEP decryption with SHA-256, written independently."""
    assert len(ciphertext) == K
    encoded = pow(int.from_bytes(ciphertext, 'big'), D, N).to_bytes(K, 'big')
    h_len = 32
    assert encoded[0] == 0, 'leading octet must be zero'
    masked_seed = encoded[1:1 + h_len]
    masked_db = encoded[1 + h_len:]
    seed = bytes(a ^ b for a, b in zip(masked_seed, _mgf1_independent(masked_db, h_len)))
    db = bytes(a ^ b for a, b in zip(masked_db, _mgf1_independent(seed, K - h_len - 1)))
    assert db[:h_len] == hashlib.sha256(b'').digest(), 'label hash mismatch'
    separator = db.index(b'\x01', h_len)
    assert set(db[h_len:separator]) <= {0}, 'padding must be all zeros'
    return db[separator + 1:]


def test_round_trip_against_known_key():
    plaintext = 'hunter2-ümlaut-secret'.encode('utf-8')
    ciphertext = _rsa_oaep_sha256_encrypt(PUBLIC_PEM, plaintext)
    assert len(ciphertext) == K
    assert _oaep_decrypt(ciphertext) == plaintext


def test_encryption_is_randomized():
    # OAEP seeds every encryption with fresh random bytes: equal plaintexts
    # must never produce equal ciphertexts.
    a = _rsa_oaep_sha256_encrypt(PUBLIC_PEM, b'same')
    b = _rsa_oaep_sha256_encrypt(PUBLIC_PEM, b'same')
    assert a != b
    assert _oaep_decrypt(a) == _oaep_decrypt(b) == b'same'


def test_empty_and_max_length_plaintexts_round_trip():
    assert _oaep_decrypt(_rsa_oaep_sha256_encrypt(PUBLIC_PEM, b'')) == b''
    longest = b'x' * (K - 2 * 32 - 2)
    assert _oaep_decrypt(_rsa_oaep_sha256_encrypt(PUBLIC_PEM, longest)) == longest
    with pytest.raises(ValueError, match='too long'):
        _rsa_oaep_sha256_encrypt(PUBLIC_PEM, longest + b'x')


def test_parse_checks_the_rsa_encryption_oid():
    n, e, k = _parse_rsa_public_key(PUBLIC_PEM)
    assert (n, e, k) == (N, 65537, K)

    # Same DER, one OID byte swapped (1.2.840.113549.1.1.1 -> .1.1.7,
    # id-RSAES-OAEP): same length, valid structure, wrong algorithm.
    import base64
    body = ''.join(
        line for line in PUBLIC_PEM.splitlines() if line and not line.startswith('-----')
    )
    der = base64.b64decode(body)
    rsa_oid = bytes.fromhex('2a864886f70d010101')
    swapped = der.replace(rsa_oid, bytes.fromhex('2a864886f70d010107'))
    assert swapped != der
    forged = (
        '-----BEGIN PUBLIC KEY-----\n'
        + base64.encodebytes(swapped).decode('ascii')
        + '-----END PUBLIC KEY-----\n'
    )
    with pytest.raises(ValueError, match='rsaEncryption'):
        _parse_rsa_public_key(forged)


def test_xor_bytes_refuses_length_mismatch():
    # zip() truncates silently; a truncated XOR inside OAEP is a malformed
    # encoding nobody would see, so unequal lengths must raise.
    assert _xor_bytes(b'\x0f\xf0', b'\xff\x00') == b'\xf0\xf0'
    with pytest.raises(ValueError, match='same length'):
        _xor_bytes(b'\x00\x00', b'\x00')
