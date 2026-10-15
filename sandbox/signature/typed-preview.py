"""Writes typed-preview.pdf, the page a typed signature is previewed on.

One white 360x120 pt page with one unsigned signature field
`bro_preview_signature` at [20, 24, 340, 96]: `brokit pdf stamp-sign` draws the
person's typed name into it in the handwriting font
(`renderTypedPreview` in agent/lib/signatures/commands.ts). The output is
deterministic; run by hand with the kit's Python (pypdf 6.19) after a change:

    python3 -I typed-preview.py > typed-preview.pdf
"""

import io
import sys

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject

writer = PdfWriter()
page = writer.add_blank_page(360, 120)
widget = DictionaryObject(
    {
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Widget"),
        NameObject("/FT"): NameObject("/Sig"),
        NameObject("/T"): TextStringObject("bro_preview_signature"),
        NameObject("/Rect"): ArrayObject([FloatObject(value) for value in (20, 24, 340, 96)]),
        NameObject("/F"): NumberObject(4),
        NameObject("/P"): page.indirect_reference,
    }
)
reference = writer._add_object(widget)
page[NameObject("/Annots")] = ArrayObject([reference])
writer._root_object[NameObject("/AcroForm")] = writer._add_object(
    DictionaryObject({NameObject("/Fields"): ArrayObject([reference]), NameObject("/SigFlags"): NumberObject(1)})
)
# No /Info: no producer string or dates, so the bytes never change.
writer._info = None
buffer = io.BytesIO()
writer.write(buffer)
sys.stdout.buffer.write(buffer.getvalue())
