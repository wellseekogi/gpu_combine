"""Read selected GGUF metadata without loading tensors or executing model code.

Only the header and metadata are validated. This does not verify tensor contents,
model provenance, or runtime compatibility. UTF-8 template text is returned exactly.
"""
import os
import struct


_SCALAR_FORMATS = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f",
                   7: "?", 10: "Q", 11: "q", 12: "d"}
_SCALAR_BYTES = {kind: struct.calcsize("<" + fmt) for kind, fmt in _SCALAR_FORMATS.items()}
_MAX_METADATA_ENTRIES = 100_000
_MAX_ARRAY_ITEMS = 2_000_000
_MAX_TENSORS = 1_000_000


class _MetadataReader:
    def __init__(self, source, limit):
        self.source = source
        self.limit = limit
        self.size = os.fstat(source.fileno()).st_size
        self.offset = 0

    def take(self, size, *, skip=False):
        if size < 0 or size > self.limit - self.offset:
            raise ValueError("GGUF metadata exceeds the configured byte limit")
        if size > self.size - self.offset:
            raise ValueError("Truncated GGUF metadata")
        self.offset += size
        if skip:
            self.source.seek(size, os.SEEK_CUR)
            return None
        result = self.source.read(size)
        if len(result) != size:
            raise ValueError("Truncated GGUF metadata")
        return result

    def integer(self, width):
        return struct.unpack("<I" if width == 4 else "<Q", self.take(width))[0]

    def string(self, *, skip=False):
        length = self.integer(8)
        raw = self.take(length, skip=skip)
        if skip:
            return None
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("GGUF metadata contains invalid UTF-8") from exc

    def skip_value(self, kind):
        if kind in _SCALAR_BYTES:
            self.take(_SCALAR_BYTES[kind], skip=True)
        elif kind == 8:
            self.string(skip=True)
        elif kind == 9:
            element_kind = self.integer(4)
            count = self.integer(8)
            if count > _MAX_ARRAY_ITEMS:
                raise ValueError("GGUF metadata array has too many items")
            if element_kind in _SCALAR_BYTES:
                self.take(count * _SCALAR_BYTES[element_kind], skip=True)
            elif element_kind == 8:
                # Every string needs its length prefix even when empty. Check
                # the full count before looping over attacker-controlled input.
                remaining = min(self.limit, self.size) - self.offset
                if count > remaining // 8:
                    raise ValueError("GGUF string array exceeds available metadata")
                for _ in range(count):
                    self.string(skip=True)
            else:
                # GGUF metadata arrays contain scalars or strings, not arrays.
                raise ValueError("Unsupported GGUF metadata array element type")
        else:
            raise ValueError("Unsupported GGUF metadata value type")


def read_metadata_fields(path, keys, max_metadata_bytes=64 * 1024 * 1024):
    """Return requested scalar/string fields, omitting absent keys.

    All metadata is bounded and checked, even after the selected fields. Selected
    arrays and duplicate fields are refused; unselected arrays are only skipped.
    Tensor data is neither read nor validated.
    """
    if (not isinstance(keys, (list, tuple, set, frozenset)) or len(keys) > 256
            or any(not isinstance(key, str) for key in keys)):
        raise ValueError("Request at most 256 named GGUF metadata fields")
    keys = frozenset(keys)
    if (isinstance(max_metadata_bytes, bool) or not isinstance(max_metadata_bytes, int)
            or max_metadata_bytes < 24):
        raise ValueError("GGUF metadata byte limit must be an integer of at least 24")
    with open(path, "rb") as source:
        reader = _MetadataReader(source, max_metadata_bytes)
        if reader.take(4) != b"GGUF":
            raise ValueError("File is not a GGUF model")
        if reader.integer(4) not in (2, 3):
            raise ValueError("Only GGUF versions 2 and 3 are supported")
        tensors = reader.integer(8)
        entries = reader.integer(8)
        if tensors > _MAX_TENSORS or tensors > reader.size // 24:
            raise ValueError("GGUF header has an invalid tensor count")
        remaining = min(reader.limit, reader.size) - reader.offset
        if entries > _MAX_METADATA_ENTRIES or entries > remaining // 13:
            raise ValueError("GGUF header has an invalid metadata count")
        result = {}
        for _ in range(entries):
            key = reader.string()
            kind = reader.integer(4)
            if key not in keys:
                reader.skip_value(kind)
            elif key in result:
                raise ValueError("Duplicate GGUF metadata field: " + key)
            elif kind == 8:
                result[key] = reader.string()
            elif kind in _SCALAR_FORMATS:
                result[key] = struct.unpack("<" + _SCALAR_FORMATS[kind], reader.take(_SCALAR_BYTES[kind]))[0]
            else:
                raise ValueError("Selected GGUF metadata must be scalar or string: " + key)
        return result


def read_chat_template(path, max_metadata_bytes=64 * 1024 * 1024):
    """Return the exact UTF-8 template, or None when valid metadata lacks it."""
    template = read_metadata_fields(path, ["tokenizer.chat_template"], max_metadata_bytes).get("tokenizer.chat_template")
    if template is not None and not isinstance(template, str):
        raise ValueError("GGUF chat template must be a single UTF-8 string")
    return template
