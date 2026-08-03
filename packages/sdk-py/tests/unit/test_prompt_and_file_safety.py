"""
Unit tests for two hostile-input guarantees:

- apply_template() expands in ONE pass: a substituted value that itself
  contains ``{{...}}`` (user prompts, verifier feedback, criteria) is never
  re-expanded by a later variable.
- save_local_dir() confines every entry to the target directory: names come
  from sandbox output, so ``../`` and absolute entries must be refused, not
  written outside the directory the caller chose.
"""

import os

import pytest

from evolve.prompts import apply_template
from evolve.utils import save_local_dir


class TestApplyTemplateSinglePass:

    def test_value_containing_later_placeholder_is_not_re_expanded(self):
        result = apply_template(
            'X={{a}} Y={{b}}',
            {'a': 'user wrote {{b}} literally', 'b': 'BEE'},
        )
        assert result == 'X=user wrote {{b}} literally Y=BEE'

    def test_value_containing_earlier_placeholder_is_not_re_expanded(self):
        result = apply_template(
            'X={{a}} Y={{b}}',
            {'a': 'AY', 'b': 'feedback quoting {{a}}'},
        )
        assert result == 'X=AY Y=feedback quoting {{a}}'

    def test_unknown_placeholders_stay_verbatim(self):
        assert apply_template('keep {{missing}}', {'a': 'x'}) == 'keep {{missing}}'


class TestSaveLocalDirConfinement:

    def test_writes_nested_entries_inside_target(self, tmp_path):
        target = tmp_path / 'out'
        save_local_dir(str(target), {'file.txt': 'top', 'sub/nested.txt': b'deep'})
        assert (target / 'file.txt').read_text() == 'top'
        assert (target / 'sub' / 'nested.txt').read_bytes() == b'deep'

    def test_refuses_parent_traversal(self, tmp_path):
        target = tmp_path / 'out'
        with pytest.raises(ValueError):
            save_local_dir(str(target), {'../escape.txt': 'nope'})
        assert not (tmp_path / 'escape.txt').exists()

    def test_refuses_absolute_entry(self, tmp_path):
        target = tmp_path / 'out'
        outside = tmp_path / 'outside.txt'
        with pytest.raises(ValueError):
            save_local_dir(str(target), {str(outside): 'nope'})
        assert not outside.exists()

    def test_allows_dotdot_that_stays_inside(self, tmp_path):
        target = tmp_path / 'out'
        save_local_dir(str(target), {os.path.join('sub', '..', 'ok.txt'): 'fine'})
        assert (target / 'ok.txt').read_text() == 'fine'
