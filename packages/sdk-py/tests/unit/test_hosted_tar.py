"""
Unit tests for _tar_gzip_directory_to_file() — the published corpus's bytes.

The sha256 of the archive this writes IS the dataset version's source identity
on the server, so its byte layout is a contract, not an implementation detail.
It also decides what a published corpus CONTAINS — a file the writer drops is
a file the eval never sees.

Mirrors packages/sdk-ts/tests/unit/hosted-tar.test.ts. Cross-language byte
identity is NOT the bar (the two gzip implementations differ); the bar is that
the two SDKs pack the same CONTENT and that each one is reproducible on its own.

Tests:
- determinism: one directory, one sha256, across runs / mtime / umask / order
  AND across output file names (gzip would embed the destination's name in its
  FNAME header field the moment it sees a real file object — suppressed, or
  the digest would move per run with the temp file's random name)
- dotfiles are PACKED; only .git, .DS_Store and .venv are skipped
- the executable bit survives, normalized to 0o755 / 0o644
- every other header field is flattened, and gzip carries no timestamp
- symlinks never enter the archive
- a path too long for a USTAR name field still packs
- the corpus streams off disk AND the archive streams to disk — neither is
  ever held whole in memory (the F1 incident: the old bytes-returning path
  cost ~10x a corpus's size in RSS through the upload stack)
- an empty directory is a valid empty archive; a missing one raises
- a mixed corpus — incompressible blobs beside text — unpacks bit-exact and
  deterministically (the gzip member is SEGMENTED: stored blocks for entries
  that sample incompressible, deflate for the rest)
- an incompressible corpus packs several-fold faster than deflating it at
  level 9 — the law the segmentation exists for
"""

import gzip
import hashlib
import io
import os
import struct
import tarfile
import tempfile
import time
import tracemalloc
import zlib

import pytest

from evolve.hosted import _should_store, _tar_gzip_directory_to_file


def _tar_gzip_directory(directory: str) -> bytes:
    """Pack via the streaming engine and read the archive back for inspection."""
    with tempfile.TemporaryDirectory(prefix='hosted-tar-test-') as tmp:
        out = os.path.join(tmp, 'archive.tar.gz')
        _tar_gzip_directory_to_file(directory, out)
        with open(out, 'rb') as handle:
            return handle.read()


# =============================================================================
# HELPERS
# =============================================================================


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(root, rel: str, content: bytes = b'x\n', mode: int = None) -> str:
    """Create a file (and its parents) under `root`, optionally chmod-ed."""
    abs_path = os.path.join(str(root), *rel.split('/'))
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, 'wb') as handle:
        handle.write(content)
    if mode is not None:
        os.chmod(abs_path, mode)
    return abs_path


def unpack(gzipped: bytes):
    """Read the archive back, header fields and all."""
    with tarfile.open(fileobj=io.BytesIO(gzipped), mode='r:gz') as tar:
        return [(member, tar.extractfile(member).read() if member.isfile() else b'')
                for member in tar.getmembers()]


def names(gzipped: bytes):
    return [member.name for member, _ in unpack(gzipped)]


# =============================================================================
# DETERMINISM
# =============================================================================


class TestDeterminism:
    """The same directory always produces the same bytes."""

    def test_two_runs_one_digest(self, tmp_path):
        write(tmp_path, 'task.toml', b"id = 'one'\n")
        write(tmp_path, 'tests/verify.py', b'assert True\n')
        write(tmp_path, 'solution/solve.sh', b'#!/bin/sh\nexit 0\n', 0o755)
        write(tmp_path, '.gitignore', b'__pycache__/\n')

        first = _tar_gzip_directory(str(tmp_path))
        second = _tar_gzip_directory(str(tmp_path))

        assert sha256(first) == sha256(second)
        assert len(first) > 0

    def test_creation_order_does_not_move_the_digest(self, tmp_path):
        forward = tmp_path / 'forward'
        reverse = tmp_path / 'reverse'
        for rel in ('a.txt', 'b.txt', 'z/nested.txt'):
            write(forward, rel, b'body\n')
        for rel in ('z/nested.txt', 'b.txt', 'a.txt'):
            write(reverse, rel, b'body\n')

        assert sha256(_tar_gzip_directory(str(forward))) == sha256(
            _tar_gzip_directory(str(reverse))
        )

    def test_mtime_does_not_move_the_digest(self, tmp_path):
        path = write(tmp_path, 'a.txt', b'a\n')
        before = sha256(_tar_gzip_directory(str(tmp_path)))

        os.utime(path, (1_000_000_000, 1_000_000_000))

        assert sha256(_tar_gzip_directory(str(tmp_path))) == before

    def test_umask_does_not_move_the_digest(self, tmp_path):
        tight = tmp_path / 'tight'
        loose = tmp_path / 'loose'
        write(tight, 'a.txt', b'a\n', 0o600)
        write(loose, 'a.txt', b'a\n', 0o644)

        assert sha256(_tar_gzip_directory(str(tight))) == sha256(
            _tar_gzip_directory(str(loose))
        )


# =============================================================================
# WHAT GETS PACKED
# =============================================================================


class TestContents:
    """Dotfiles are corpus content; only the three junk names are dropped."""

    def test_dotfiles_are_packed(self, tmp_path):
        write(tmp_path, 'task.toml', b"id = 'one'\n")
        write(tmp_path, '.gitignore', b'__pycache__/\n')
        write(tmp_path, '.dockerignore', b'.git\n')
        write(tmp_path, '.env.example', b'API_KEY=\n')
        write(tmp_path, '.config/settings.json', b'{}\n')
        write(tmp_path, 'nested/.hidden-rc', b'x\n')
        write(tmp_path, '.git/config', b'[core]\n')
        write(tmp_path, '.venv/pyvenv.cfg', b'home = /usr\n')
        write(tmp_path, '.DS_Store', b'junk')
        write(tmp_path, 'nested/.DS_Store', b'junk')

        assert names(_tar_gzip_directory(str(tmp_path))) == [
            '.config/settings.json',
            '.dockerignore',
            '.env.example',
            '.gitignore',
            'nested/.hidden-rc',
            'task.toml',
        ]

    def test_executable_bit_survives_normalized(self, tmp_path):
        write(tmp_path, 'run.sh', b'#!/bin/sh\nexit 0\n', 0o755)
        write(tmp_path, 'odd.sh', b'#!/bin/sh\nexit 0\n', 0o711)
        write(tmp_path, 'notes.md', b'hello\n', 0o644)
        write(tmp_path, 'tight.md', b'hello\n', 0o600)

        modes = {member.name: member.mode
                 for member, _ in unpack(_tar_gzip_directory(str(tmp_path)))}

        assert modes['run.sh'] == 0o755
        assert modes['odd.sh'] == 0o755
        assert modes['notes.md'] == 0o644
        assert modes['tight.md'] == 0o644

    def test_headers_carry_no_machine_identity(self, tmp_path):
        write(tmp_path, 'a.txt', b'a\n')

        gzipped = _tar_gzip_directory(str(tmp_path))
        (member, content), = unpack(gzipped)

        assert member.mtime == 0
        assert member.uid == 0
        assert member.gid == 0
        assert member.uname == ''
        assert member.gname == ''
        assert content == b'a\n'
        # Bytes 4..8 of a gzip member are its MTIME field.
        assert int.from_bytes(gzipped[4:8], 'little') == 0

    def test_symlinks_never_enter_the_archive(self, tmp_path):
        write(tmp_path, 'real.txt', b'real\n')
        write(tmp_path, 'dir/inner.txt', b'inner\n')
        os.symlink(str(tmp_path / 'real.txt'), str(tmp_path / 'link.txt'))
        os.symlink(str(tmp_path / 'dir'), str(tmp_path / 'dirlink'))

        assert names(_tar_gzip_directory(str(tmp_path))) == ['dir/inner.txt', 'real.txt']

    def test_long_paths_pack(self, tmp_path):
        long_rel = f"{'d' * 120}/{'f' * 120}.txt"
        write(tmp_path, long_rel, b'deep\n')

        first = _tar_gzip_directory(str(tmp_path))
        second = _tar_gzip_directory(str(tmp_path))
        entries = unpack(first)

        assert [member.name for member, _ in entries] == [long_rel]
        assert entries[0][1] == b'deep\n'
        assert sha256(first) == sha256(second)


# =============================================================================
# STREAMING AND EDGE CASES
# =============================================================================


class TestStreamingAndEdges:
    """The corpus never sits in memory whole, and the boundaries behave."""

    def test_corpus_streams_off_disk_and_archive_streams_to_disk(self, tmp_path):
        # Incompressible-ish content: the archive is ~as large as the corpus,
        # so tracemalloc bounds the OUTPUT side too — the F1 fence at the
        # packer level (the old bytes-returning path held the whole archive).
        # Written a chunk at a time so the test itself never holds the file.
        megabyte = 1024 * 1024
        size = 64 * megabyte
        chunk = bytes((i * 31 + (i >> 9) * 131) & 0xFF for i in range(4 * megabyte))
        corpus = tmp_path / 'corpus'
        corpus.mkdir()
        with open(str(corpus / 'big.bin'), 'wb') as handle:
            for _ in range(size // len(chunk)):
                handle.write(chunk)

        out = str(tmp_path / 'big.tar.gz')
        tracemalloc.start()
        try:
            _tar_gzip_directory_to_file(str(corpus), out)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        assert peak < 8 * megabyte, f'held {peak / megabyte:.1f}MB for a 64MB corpus+archive'
        with open(out, 'rb') as handle:
            entries = unpack(handle.read())
        assert len(entries) == 1
        assert len(entries[0][1]) == size

    def test_output_name_never_reaches_the_bytes(self, tmp_path):
        # Two different destinations, one digest: gzip's FNAME header field is
        # suppressed, or a real file object would leak the (random) temp
        # file's name into the bytes and move the server-side source identity
        # per run.
        corpus = tmp_path / 'corpus'
        corpus.mkdir()
        write(corpus, 'a.txt', b'a\n')
        out_a = str(tmp_path / 'first-name.tar.gz')
        out_b = str(tmp_path / 'a-completely-different-name.tar.gz')
        _tar_gzip_directory_to_file(str(corpus), out_a)
        _tar_gzip_directory_to_file(str(corpus), out_b)
        with open(out_a, 'rb') as fa, open(out_b, 'rb') as fb:
            assert sha256(fa.read()) == sha256(fb.read())

    def test_empty_directory_is_a_valid_empty_archive(self, tmp_path):
        gzipped = _tar_gzip_directory(str(tmp_path))

        assert unpack(gzipped) == []
        # End-of-archive: nothing but zero blocks. Python's tarfile pads to its
        # 10240-byte record, where tar-stream stops at the two blocks — a
        # per-language padding difference, not a content one.
        archive = gzip.decompress(gzipped)
        assert len(archive) >= 1024
        assert archive == bytes(len(archive))

    def test_missing_directory_raises(self, tmp_path):
        with pytest.raises(ValueError, match='directory not found'):
            _tar_gzip_directory(str(tmp_path / 'nope'))


# =============================================================================
# SEGMENTED GZIP MEMBER (stored blocks for incompressible entries)
# =============================================================================


def _incompressible(length: int) -> bytes:
    """Deterministic bytes that SAMPLE incompressible: the TypeScript suite's
    multiplicative mix, one 32-bit word per 4 bytes — its level-1 deflate of a
    128 KiB head keeps 99.6% of the size, safely over the 95% stored
    threshold. (A previous fixture kept only 85% and silently rode DEFLATE —
    the premise assertions in the test below exist so that can never happen
    unnoticed again.)"""
    words = (length + 3) // 4
    out = bytearray(words * 4)
    for i in range(0, words * 4, 4):
        struct.pack_into('<I', out, i, ((i ^ 0x9E3779B9) * 2654435761) & 0xFFFFFFFF)
    return bytes(out[:length])


class TestSegmentedMember:
    """Entries that sample incompressible ride STORED deflate blocks; the
    member stays ONE standard gzip stream any gunzip reads. Mirrors the
    TypeScript suite's [11]/[12]."""

    def test_mixed_corpus_round_trips_across_segment_switches(self, tmp_path):
        # Archive opens stored, switches to deflate, switches back, closes
        # stored (the sort puts a blob first and last); the odd blob length
        # exercises the final partial stored block.
        blob = _incompressible(3 * 1024 * 1024 + 12345)
        text = b'a compressible line of corpus text\n' * 60000
        write(tmp_path, 'task.toml', b"id = 'mixed'\n")
        write(tmp_path, 'tests/verify.py', b'assert True\n')
        write(tmp_path, 'aaa-first.bin', blob)
        write(tmp_path, 'notes.md', text)
        write(tmp_path, 'zzz-last.bin', blob)

        # The premise every switch below stands on, asserted so a fixture
        # change can never hollow this test into an all-deflate archive
        # without failing loudly.
        assert _should_store(str(tmp_path / 'aaa-first.bin'), len(blob)), \
            'premise: the blob must sample incompressible (ride STORED)'
        assert _should_store(str(tmp_path / 'zzz-last.bin'), len(blob)), \
            'premise: the blob must sample incompressible (ride STORED)'
        assert not _should_store(str(tmp_path / 'notes.md'), len(text)), \
            'premise: the text must sample compressible (ride DEFLATE)'

        first = _tar_gzip_directory(str(tmp_path))
        second = _tar_gzip_directory(str(tmp_path))

        assert sha256(first) == sha256(second), 'a mixed corpus is still deterministic'
        by_name = {member.name: content for member, content in unpack(first)}
        assert len(by_name) == 5
        assert by_name['aaa-first.bin'] == blob
        assert by_name['zzz-last.bin'] == blob
        assert by_name['notes.md'] == text
        # Smaller than its raw content: the blobs ride ~1:1, so only a working
        # deflate segment can make up the difference.
        assert len(first) < 2 * len(blob) + len(text), 'the deflate segment still compresses the text'
        # Plain gzip reads the segmented member — the format did not fork.
        assert len(gzip.decompress(first)) > 2 * len(blob)

    def test_incompressible_corpus_packs_without_recompression(self, tmp_path):
        # The law the segmented member exists for: a corpus that cannot
        # compress is PACKED, not recompressed. Measured relative to a
        # level-9 deflate of the same bytes in the same process, so machine
        # speed cancels out; the stored path runs ~20x faster than the
        # deflate path, and the old always-deflate engine sat at ~1x — the
        # halfway bound is far from both.
        blob = os.urandom(32 * 1024 * 1024)
        corpus = tmp_path / 'corpus'
        write(corpus, 'task.toml', b"id = 'blob'\n")
        write(corpus, 'weights.bin', blob)
        out = str(tmp_path / 'blob.tar.gz')

        t9 = time.perf_counter()
        zlib.compress(blob, 9)
        deflate_seconds = time.perf_counter() - t9

        t = time.perf_counter()
        _tar_gzip_directory_to_file(str(corpus), out)
        pack_seconds = time.perf_counter() - t

        assert pack_seconds * 2 < deflate_seconds, (
            f'packing 32MB of incompressible bytes must beat half a level-9 '
            f'deflate of them (pack {pack_seconds:.2f}s vs deflate {deflate_seconds:.2f}s)'
        )
        with open(out, 'rb') as handle:
            by_name = {member.name: content for member, content in unpack(handle.read())}
        assert by_name['weights.bin'] == blob, 'the stored blob round-trips bit-exact'
