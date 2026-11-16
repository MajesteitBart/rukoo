"""Makes test/fixtures/encrypted-pdfs.json: small PDFs that pypdf encrypts, so the tests of Rukoo's PDF reader
decrypt what another implementation encrypted. Run it from the repository root when the fixtures change:

    python -I test/fixtures/encrypt-pdfs.py

It needs pypdf 6 and cryptography. AES uses random IVs, so each run writes other bytes with the same text.

Each PDF has one page in Helvetica with TEXT. Those made by pypdf's writer are as pypdf writes an encrypted file;
the others are written here, with pypdf's encryption, to have what its writer doesn't make: the page tree and the
font in an object stream, EncryptMetadata false, streams left unencrypted by StmF or by their own Crypt filter, a
compressed bomb, and a user password.
"""

import base64
import io
import json
import os
import zlib

from pypdf import PdfReader, PdfWriter
from pypdf._encryption import EncryptAlgorithm, Encryption
from pypdf.generic import BooleanObject, DictionaryObject, NameObject, NumberObject

# WinAnsi bytes: e acute and the euro sign.
LINES = [b"Encrypted invoice", b"Total: caf\xe9 \x80 12"]
ID1 = bytes.fromhex("6b1f4c0e2a9d4f7b8e3c5a1d0f2e4b6c")
CATALOG = b"<</Type/Catalog/Pages 2 0 R>>"
TREE = b"<</Type/Pages/Kids[5 0 R]/Count 1>>"
FONT = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>"


def page(contents=b"4 0 R"):
    return b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents " + contents + b">>"


def show(lines):
    return b" T* ".join(b"(" + line + b") Tj" for line in lines)


def content(lines=LINES):
    return b"BT /F1 12 Tf 72 760 Td 16 TL " + show(lines) + b" ET"


def base_objects():
    return {1: CATALOG, 2: TREE, 3: FONT, 4: (b"/Filter/FlateDecode", zlib.compress(content())), 5: page()}


def write(objects, enc=None, entry=None, packed=(), plain=()):
    """objects: number -> a value, or (dictionary entries, data as stored) for a stream. enc encrypts every stream
    but those in plain; the encryption dictionary (entry) and the cross-reference stream stay as written. packed:
    the numbers that go into one object stream."""
    objs = dict(objects)
    n = max(objs)
    stm = None
    if packed:
        head, body = b"", b""
        for num in packed:
            head += b"%d %d " % (num, len(body))
            body += objs.pop(num) + b"\n"
        n += 1
        stm = n
        objs[stm] = (b"/Type/ObjStm/N %d/First %d/Filter/FlateDecode" % (len(packed), len(head)), zlib.compress(head + body))
    trailer = b"/Root 1 0 R/ID[<%s><%s>]" % (ID1.hex().encode(), ID1.hex().encode())
    if entry is not None:
        n += 1
        buf = io.BytesIO()
        entry.write_to_stream(buf)
        objs[n] = buf.getvalue()
        trailer += b"/Encrypt %d 0 R" % n
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        body = objs[num]
        if isinstance(body, tuple):
            entries, data = body
            if enc is not None and num not in plain:
                data = enc._make_crypt_filter(num, 0).stm_crypt.encrypt(data)
            out += b"%d 0 obj\n<<%s/Length %d>>\nstream\n" % (num, entries, len(data)) + data + b"\nendstream\nendobj\n"
        else:
            out += b"%d 0 obj\n%s\nendobj\n" % (num, body)
    xref = n + 1
    offsets[xref] = len(out)
    rows = b""
    for num in range(xref + 1):
        if num in offsets:
            rows += b"\x01" + offsets[num].to_bytes(4, "big") + b"\x00\x00"
        elif num in packed:
            rows += b"\x02" + stm.to_bytes(4, "big") + packed.index(num).to_bytes(2, "big")
        else:
            rows += b"\x00\x00\x00\x00\x00\xff\xff"
    out += b"%d 0 obj\n<</Type/XRef/Size %d/W[1 4 2]%s/Length %d>>\nstream\n" % (xref, xref + 1, trailer, len(rows)) + rows + b"\nendstream\nendobj\n"
    out += b"startxref\n%d\n%%%%EOF\n" % offsets[xref]
    return bytes(out)


def by_writer(algorithm, user=""):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(write(base_objects()))))
    writer.encrypt(user_password=user, owner_password="owner", algorithm=algorithm)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def encryption(algorithm, metadata=True):
    enc = Encryption.make(getattr(EncryptAlgorithm, algorithm.replace("-", "_")), -4, ID1)
    enc.EncryptMetadata = metadata
    entry = enc.write_entry("", "owner")
    if not metadata:
        entry[NameObject("/EncryptMetadata")] = BooleanObject(False)
    return enc, entry


def object_stream(algorithm):
    enc, entry = encryption(algorithm)
    return write(base_objects(), enc, entry, packed=[2, 3])


def no_metadata():
    enc, entry = encryption("AES-128", metadata=False)
    objects = base_objects()
    objects[1] = b"<</Type/Catalog/Pages 2 0 R/Metadata 6 0 R>>"
    objects[6] = (b"/Type/Metadata/Subtype/XML", b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="r"?>')
    return write(objects, enc, entry, plain=[6])


def identity_streams():
    enc, entry = encryption("AES-128")
    entry[NameObject("/StmF")] = NameObject("/Identity")
    enc.StmF = "/Identity"
    return write(base_objects(), enc, entry)


def crypt_filter():
    # The first line in a stream whose own Crypt filter is Identity, left as written; the second encrypted.
    enc, entry = encryption("AES-128")
    objects = base_objects()
    first = b"BT /F1 12 Tf 72 760 Td 16 TL " + show(LINES[:1])
    objects[4] = (b"/Filter[/Crypt/FlateDecode]/DecodeParms[<</Type/CryptFilterDecodeParms/Name/Identity>> null]", zlib.compress(first))
    objects[6] = (b"/Filter/FlateDecode", zlib.compress(b"T* " + show(LINES[1:]) + b" ET"))
    objects[5] = page(b"[4 0 R 6 0 R]")
    return write(objects, enc, entry, plain=[4])


def bomb():
    # "start" on the page, then 100 MiB of spaces compressed twice: a few hundred bytes in the file.
    enc, entry = encryption("RC4-128")
    objects = base_objects()
    objects[4] = (b"/Filter/FlateDecode", zlib.compress(b"BT /F1 12 Tf 72 760 Td (start) Tj ET"))
    objects[6] = (b"/Filter[/FlateDecode/FlateDecode]", zlib.compress(zlib.compress(b" " * (100 * 1024 * 1024), 9), 9))
    objects[5] = page(b"[4 0 R 6 0 R]")
    return write(objects, enc, entry)


def main():
    pdfs = {
        "rc4_40": by_writer("RC4-40"),
        "rc4_128": by_writer("RC4-128"),
        "aes_128": by_writer("AES-128"),
        "aes_256_r5": by_writer("AES-256-R5"),
        "aes_256": by_writer("AES-256"),
        "rc4_40_objstm": object_stream("RC4-40"),
        "rc4_128_objstm": object_stream("RC4-128"),
        "aes_128_objstm": object_stream("AES-128"),
        "aes_256_objstm": object_stream("AES-256"),
        "no_metadata": no_metadata(),
        "identity_streams": identity_streams(),
        "crypt_filter": crypt_filter(),
        "bomb": bomb(),
        "password": by_writer("AES-128", user="secret"),
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "encrypted-pdfs.json")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump({k: base64.b64encode(v).decode() for k, v in pdfs.items()}, f, indent=1)
        f.write("\n")
    print(out, {k: len(v) for k, v in pdfs.items()})


if __name__ == "__main__":
    main()
