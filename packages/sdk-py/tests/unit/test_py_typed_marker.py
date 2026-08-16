"""The typing promise has to be INSTALLED, not just written.

This package annotates everything a caller touches: closed ``Literal``
vocabularies for the statuses, ``HostedErrorCode`` so a typo is a type error,
TypedDicts wherever the value IS the wire dict. None of it reaches a type
checker without the PEP 561 marker: mypy reads an installed distribution as
untyped unless the package ships ``py.typed``, and discards every annotation in
it. The annotations were there and the marker was not, so the whole feature was
a silent zero for exactly the users it was built for.

Two halves, and the promise needs both — the file in the tree, and the
packaging entry that puts it in the wheel. This gate holds both, because
deleting either one alone fails the same way and leaves no other trace.
"""

import re
from pathlib import Path

SDK_PY_ROOT = Path(__file__).resolve().parents[2]
MARKER = SDK_PY_ROOT / 'evolve' / 'py.typed'
PYPROJECT = SDK_PY_ROOT / 'pyproject.toml'


def test_the_marker_file_exists() -> None:
    """PEP 561's marker for an inline-typed package, at the package root.

    It covers the subpackages too, so this single file is what makes
    ``evolve``, ``evolve.swarm`` and ``evolve.pipeline`` all readable to a type
    checker.
    """
    assert MARKER.is_file(), (
        f'{MARKER} is missing — without it mypy treats the installed package '
        'as untyped and every annotation in it is discarded'
    )


def test_the_marker_ships_in_the_package_data() -> None:
    """A marker the build leaves behind is a marker the caller never sees."""
    text = PYPROJECT.read_text(encoding='utf-8')
    entry = re.search(r'^evolve = \[(.*)\]$', text, flags=re.MULTILINE)
    assert entry is not None, 'no [tool.setuptools.package-data] entry for evolve'
    assert 'py.typed' in entry.group(1), (
        'evolve package-data does not list py.typed, so the wheel ships '
        'without the marker however present the file is in the tree'
    )
