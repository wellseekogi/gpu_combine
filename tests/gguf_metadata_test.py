"""Bounded GGUF metadata parsing; fixtures contain no model weights."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "gguf_metadata", Path(__file__).parents[1] / "provider" / "gguf_metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


def text(value):
    raw = value.encode("utf-8")
    return struct.pack("<Q", len(raw)) + raw


def entry(key, kind, raw):
    return text(key) + struct.pack("<I", kind) + raw


def gguf(*entries, version=3, tensors=0):
    return b"GGUF" + struct.pack("<IQQ", version, tensors, len(entries)) + b"".join(entries)


class GGUFMetadataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "model.gguf"

    def read(self, raw, **kwargs):
        self.path.write_bytes(raw)
        return metadata.read_chat_template(self.path, **kwargs)

    def test_supported_versions_preserve_unicode_and_whitespace_exactly(self):
        template = "\ufeff{% for message in messages %}\r\n한글 🦙\n{{ message.content }}{% endfor %}  \n"
        for version in (2, 3):
            with self.subTest(version=version):
                result = self.read(gguf(entry("tokenizer.chat_template", 8, text(template)), version=version))
                self.assertEqual(result.encode("utf-8"), template.encode("utf-8"))

    def test_skips_scalars_and_arrays_before_template_without_reading_tensor_tail(self):
        values = [entry("scalar" + str(kind), kind, bytes(size))
                  for kind, size in metadata._SCALAR_BYTES.items()]
        values += [entry("tokens", 9, struct.pack("<IQ", 8, 3) + text("a") + text("") + text("한글")),
                   entry("scores", 9, struct.pack("<IQ", 6, 3) + struct.pack("<fff", 1, 2, 3)),
                   entry("empty", 9, struct.pack("<IQ", 8, 0)),
                   entry("tokenizer.chat_template", 8, text("{{ messages }}\n"))]
        raw = gguf(*values)
        self.assertEqual(self.read(raw + b"TENSOR DATA MUST NOT BE PARSED", max_metadata_bytes=len(raw)),
                         "{{ messages }}\n")

    def test_missing_and_empty_templates_are_distinct(self):
        self.assertIsNone(self.read(gguf(entry("general.name", 8, text("Test")))))
        self.assertEqual(self.read(gguf(entry("tokenizer.chat_template", 8, text("")))), "")

    def test_rejects_every_truncated_metadata_prefix(self):
        raw = gguf(entry("tokens", 9, struct.pack("<IQ", 8, 2) + text("abc") + text("def")),
                   entry("tokenizer.chat_template", 8, text("template")))
        for end in range(len(raw)):
            with self.subTest(end=end), self.assertRaises(ValueError):
                self.read(raw[:end])

    def test_rejects_invalid_magic_versions_and_header_counts(self):
        cases = [b"NOPE" + gguf()[4:], gguf(version=1), gguf(version=4),
                 b"GGUF" + struct.pack("<IQQ", 3, 2**64 - 1, 0),
                 b"GGUF" + struct.pack("<IQQ", 3, 0, 2**64 - 1)]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.read(raw)

    def test_rejects_excessive_string_and_array_lengths_before_looping(self):
        cases = [entry("huge", 8, struct.pack("<Q", 2**64 - 1)),
                 entry("huge", 9, struct.pack("<IQ", 8, 2**64 - 1)),
                 entry("huge", 9, struct.pack("<IQ", 8, 100)),
                 entry("huge", 9, struct.pack("<IQ", 4, 100))]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.read(gguf(value))

    def test_rejects_unknown_types_nested_arrays_and_invalid_template_types(self):
        cases = [entry("unknown", 13, b"x"),
                 entry("nested", 9, struct.pack("<IQ", 9, 0)),
                 entry("unknown-array", 9, struct.pack("<IQ", 99, 0)),
                 entry("tokenizer.chat_template", 4, struct.pack("<I", 0))]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.read(gguf(value))

    def test_rejects_duplicate_template_and_invalid_utf8(self):
        template = entry("tokenizer.chat_template", 8, text("valid"))
        with self.assertRaises(ValueError):
            self.read(gguf(template, template))
        with self.assertRaises(ValueError):
            self.read(gguf(entry("tokenizer.chat_template", 8, struct.pack("<Q", 1) + b"\xff")))
        with self.assertRaises(ValueError):
            self.read(gguf(struct.pack("<Q", 1) + b"\xff" + struct.pack("<I", 0) + b"\x00"))

    def test_metadata_limit_cannot_be_bypassed_by_seeking_arrays(self):
        raw = gguf(entry("data", 9, struct.pack("<IQ", 0, 100) + bytes(100)))
        with self.assertRaises(ValueError):
            self.read(raw, max_metadata_bytes=len(raw) - 1)
        for limit in (0, -1, 23, True, 24.0):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                self.read(raw, max_metadata_bytes=limit)

    def test_validates_metadata_following_the_template(self):
        raw = gguf(entry("tokenizer.chat_template", 8, text("valid")), entry("bad", 99, b"x"))
        with self.assertRaises(ValueError):
            self.read(raw)

    def test_selected_fields_decode_scalars_skip_arrays_and_reject_duplicates(self):
        fields = {"arch": "llama", "layers": 32, "signed": -1, "wide": 2**40, "boolean": True, "float": 1.5}
        raw = gguf(entry("arch", 8, text("llama")), entry("layers", 4, struct.pack("<I", 32)),
                   entry("signed", 5, struct.pack("<i", -1)), entry("wide", 10, struct.pack("<Q", 2**40)),
                   entry("boolean", 7, struct.pack("<?", True)), entry("float", 6, struct.pack("<f", 1.5)),
                   entry("tokens", 9, struct.pack("<IQ", 8, 2) + text("a") + text("b")))
        self.path.write_bytes(raw + b"unread tensor tail")
        self.assertEqual(metadata.read_metadata_fields(self.path, [*fields, "missing"], len(raw)), fields)
        with self.assertRaisesRegex(ValueError, "scalar"):
            metadata.read_metadata_fields(self.path, ["tokens"])
        duplicate = entry("layers", 4, struct.pack("<I", 32))
        self.path.write_bytes(gguf(duplicate, duplicate))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            metadata.read_metadata_fields(self.path, ["layers"])
        for keys in ("layers", [None], ["x"] * 257):
            with self.subTest(keys=keys), self.assertRaises(ValueError):
                metadata.read_metadata_fields(self.path, keys)


if __name__ == "__main__":
    unittest.main()
