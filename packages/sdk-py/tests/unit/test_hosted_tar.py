"""
Unit tests for _tar_gzip_directory() — the published corpus's bytes.

The sha256 of what this function returns IS the dataset version's source
identity on the server, so its byte layout is a contract, not an implementation
detail. It also decides what a published corpus CONTAINS — a file the writer
drops is a file the eval never sees.

Mirrors packages/sdk-ts/tests/unit/hosted-tar.test.ts. Cross-language byte
identity is NOT the bar (the two gzip implementations differ); the bar is that
the two SDKs pack the same CONTENT and that each one is reproducible on its own.

Tests:
- determinism: one directory, one sha256, across runs / mtime / umask / order
- dotfiles are PACKED; only .git, .DS_Store and .venv are skipped
- the executable bit survives, normalized to 0o755 / 0o644
- every other header field is flattened, and gzip carries no timestamp
- symlinks never enter the archive
- a path too long for a USTAR name field still packs
- the corpus streams off disk instead of being held whole in memory
- an empty directory is a valid empty archive; a missing one raises
"""

import gzip
import hashlib
import io
import os
import tarfile
import tracemalloc

import pytest

from evolve.hosted import _tar_gzip_directory


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

    def test_corpus_streams_off_disk(self, tmp_path):
        # Zeros: large on disk, tiny once gzipped, so anything tracemalloc sees
        # is the INPUT side. Written a chunk at a time so the test itself never
        # holds the file either.
        megabyte = 1024 * 1024
        size = 64 * megabyte
        chunk = bytes(4 * megabyte)
        with open(str(tmp_path / 'big.bin'), 'wb') as handle:
            for _ in range(size // len(chunk)):
                handle.write(chunk)

        tracemalloc.start()
        try:
            gzipped = _tar_gzip_directory(str(tmp_path))
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        assert peak < 8 * megabyte, f'held {peak / megabyte:.1f}MB for a 64MB file'
        entries = unpack(gzipped)
        assert len(entries) == 1
        assert len(entries[0][1]) == size

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
