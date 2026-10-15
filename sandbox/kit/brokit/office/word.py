"""brokit docx fill / edit / compare / text.

Word keeps a paragraph's text in runs (w:r) that split anywhere — «{ФИО}» can
be three runs — so every command works on the paragraph's live text and maps
character offsets back to runs, splitting a run where an edit starts or ends.

- fill: placeholders «{{key}}» or «{key}» (body, tables, text boxes, headers,
  footers); the first touched run gets the value with its formatting, the rest
  of the placeholder is trimmed. A key that is no placeholder fills the first
  «___» after that label, underlined. VALUES may be a list: one file per item
  (a mail merge).
- edit: tracked changes as Word writes them: deleted text in w:del/w:delText,
  new text in w:ins, both with w:author and w:date; an inserted paragraph is
  inside w:ins including its paragraph mark and copies the anchor's numbering,
  so «6.3» becomes «6.4» by itself.
- compare: a redline of A -> B built on B: paragraphs aligned, changed ones
  diffed by words, paragraphs only in A come back deleted and those only in B
  are marked inserted, both with their marks. Accept all gives B, reject all A.
- text: the text as it reads with changes accepted, rejected or shown.

python-docx saves the parts it did not touch byte for byte.
"""

import copy
import datetime
import difflib
import os
import re

from brokit.util import KitError, need_file, out_path, parser, read_json

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def w(tag):
    return "{%s}%s" % (W_NS, tag)


# Elements a paragraph's runs may sit in; w:del and w:moveFrom hold text that is
# already deleted and is not part of the live text.
RUN_CONTAINERS = {
    w(tag)
    for tag in ("hyperlink", "ins", "moveTo", "smartTag", "customXml", "fldSimple", "dir", "bdo", "sdt", "sdtContent")
}
DELETED = {w("del"), w("moveFrom")}
TEXT_CHARS = 20000
MAX_CHANGES_LISTED = 30
TOKEN = re.compile(r"\w+|\s+|[^\w\s]", re.U)
# Redline words are whitespace-delimited, so «10 (десяти)» -> «30 (тридцати)»
# reads as one change; a paragraph rewritten more than this is shown by sentences.
WORD = re.compile(r"\S+|\s+", re.U)
SENTENCE = re.compile(r".+?(?:[.!?;:](?=\s)|$)\s*", re.U | re.S)
WORD_DIFF_MIN_RATIO = 0.8
PLACEHOLDER_LEFT = re.compile(r"\{\{[^{}\n]{1,60}\}\}|\{[^{}\s\d][^{}\n]{0,58}\}")
BLANK = re.compile(r"_{3,}")


# ---------------------------------------------------------------- documents


def open_document(path):
    import docx
    from docx.opc.exceptions import PackageNotFoundError

    need_file(path)
    with open(path, "rb") as handle:
        head = handle.read(8)
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        raise KitError(
            "unsupported",
            "this is an old Word .doc file",
            "convert it first: soffice --headless --convert-to docx --outdir DIR FILE.doc",
        )
    try:
        return docx.Document(path)
    except (PackageNotFoundError, KeyError, ValueError) as error:
        raise KitError("unreadable", "not a readable .docx: " + str(error)[:120])
    except Exception as error:  # noqa: BLE001 — lxml or zip errors of a broken file
        raise KitError("unreadable", "not a readable .docx: %s: %s" % (type(error).__name__, str(error)[:100]))


def text_parts(document):
    """XML roots of the main document, headers, footers, footnotes and endnotes."""
    from docx.opc.constants import CONTENT_TYPE as CT

    wanted = {CT.WML_DOCUMENT_MAIN, CT.WML_HEADER, CT.WML_FOOTER, CT.WML_FOOTNOTES, CT.WML_ENDNOTES}
    roots = []
    for part in document.part.package.iter_parts():
        if part.content_type in wanted and hasattr(part, "element"):
            roots.append(part.element)
    return roots


def all_paragraphs(roots):
    for root in roots:
        for paragraph in root.iter(w("p")):
            yield paragraph


# ---------------------------------------------------------------- run model


def runs_of(paragraph):
    """The paragraph's live runs in order (not inside w:del, not nested text boxes)."""

    def walk(element):
        for child in element:
            if child.tag == w("r"):
                yield child
            elif child.tag in RUN_CONTAINERS:
                yield from walk(child)

    return list(walk(paragraph))


def piece_text(child):
    tag = child.tag
    if tag in (w("t"), w("delText")):
        return child.text or ""
    if tag == w("tab"):
        return "\t"
    if tag in (w("br"), w("cr")):
        return "\n"
    if tag == w("noBreakHyphen"):
        return "-"
    return None


def segments(paragraph):
    """[(run, child, start, end)] of text-bearing run children, and the text."""
    out = []
    position = 0
    for run in runs_of(paragraph):
        for child in run:
            text = piece_text(child)
            if text:
                out.append((run, child, position, position + len(text)))
                position += len(text)
    return out, "".join(piece_text(child) for _, child, _, _ in out)


def paragraph_text(paragraph):
    return segments(paragraph)[1]


def text_element(tag, text):
    from docx.oxml import OxmlElement

    element = OxmlElement(tag)
    element.text = text
    if text != text.strip() or "  " in text:
        element.set(XML_SPACE, "preserve")
    return element


def text_children(text, deleted=False):
    """w:t / w:tab / w:br children for a text with tabs and line breaks."""
    from docx.oxml import OxmlElement

    children = []
    for piece in re.split(r"(\t|\n)", text):
        if piece == "\t":
            children.append(OxmlElement("w:tab"))
        elif piece == "\n":
            children.append(OxmlElement("w:br"))
        elif piece:
            children.append(text_element("w:delText" if deleted else "w:t", piece))
    return children


def new_run(text, rpr=None, deleted=False):
    from docx.oxml import OxmlElement

    run = OxmlElement("w:r")
    if rpr is not None:
        run.append(copy.deepcopy(rpr))
    for child in text_children(text, deleted):
        run.append(child)
    return run


def run_properties(run):
    return run.find(w("rPr")) if run is not None else None


def split_run(run, child, offset):
    """Moves `child` (from `offset` of its text) and what follows into a new run after `run`."""
    tail = copy.deepcopy(run)
    for item in list(tail):
        if item.tag != w("rPr"):
            tail.remove(item)
    children = [item for item in run if item.tag != w("rPr")]
    index = children.index(child)
    moving = children[index + 1 :]
    if offset > 0:
        text = child.text or ""
        rest = copy.deepcopy(child)
        child.text = text[:offset]
        rest.text = text[offset:]
        for piece in (child, rest):
            if piece.text != piece.text.strip():
                piece.set(XML_SPACE, "preserve")
        tail.append(rest)
    else:
        moving = [child] + moving
    for item in moving:
        run.remove(item)
        tail.append(item)
    run.addnext(tail)
    return tail


def boundary(paragraph, position):
    """Makes a run boundary at a character offset of the live text."""
    parts, _ = segments(paragraph)
    for run, child, start, end in parts:
        if start < position < end:
            split_run(run, child, position - start)
            return
        if position == start:
            first = next(item for item in run if piece_text(item))
            if child is not first:
                split_run(run, child, 0)
            return


def runs_in(paragraph, start, end):
    """Runs whose whole text lies in [start, end) after boundaries at both ends."""
    boundary(paragraph, start)
    boundary(paragraph, end)
    parts, _ = segments(paragraph)
    chosen = []
    for run, _, s, e in parts:
        if s >= start and e <= end and run not in chosen:
            chosen.append(run)
    return chosen


def insertion_point(paragraph, position):
    """(element, before) to insert new content at a live-text offset."""
    boundary(paragraph, position)
    parts, text = segments(paragraph)
    for run, _, start, _ in parts:
        if start == position:
            node = run
            while node.getparent().tag == w("ins") and node.getparent()[0] is node:
                node = node.getparent()
            return node, True
    runs = runs_of(paragraph)
    if runs:
        node = runs[-1]
        while node.getparent().tag == w("ins") and node.getparent()[-1] is node:
            node = node.getparent()
        return node, False
    return None, False


def place(paragraph, position, element):
    anchor, before = insertion_point(paragraph, position)
    if anchor is None:
        paragraph.append(element)
    elif before:
        anchor.addprevious(element)
    else:
        anchor.addnext(element)


def rpr_at(paragraph, position):
    parts, _ = segments(paragraph)
    for run, _, start, end in parts:
        if start <= position < end:
            return run_properties(run)
    return run_properties(parts[-1][0]) if parts else None


# ---------------------------------------------------------------- revisions


class Revisions:
    """Tracked-change attributes with document-wide unique ids."""

    def __init__(self, roots, author, date):
        self.author = author
        self.date = date
        highest = 0
        for root in roots:
            for element in root.iter():
                value = element.get(w("id"))
                if value and value.lstrip("-").isdigit():
                    highest = max(highest, int(value))
        self.next_id = highest + 1
        self.insertions = 0
        self.deletions = 0

    def mark(self, tag):
        from docx.oxml import OxmlElement

        element = OxmlElement(tag)
        element.set(w("id"), str(self.next_id))
        element.set(w("author"), self.author)
        element.set(w("date"), self.date)
        self.next_id += 1
        if tag == "w:ins":
            self.insertions += 1
        else:
            self.deletions += 1
        return element

    def delete_runs(self, runs):
        for run in runs:
            wrapper = self.mark("w:del")
            run.addprevious(wrapper)
            wrapper.append(run)
            for child in run:
                if child.tag == w("t"):
                    child.tag = w("delText")
                elif child.tag == w("instrText"):
                    child.tag = w("delInstrText")

    def insert_runs(self, runs):
        for run in runs:
            wrapper = self.mark("w:ins")
            run.addprevious(wrapper)
            wrapper.append(run)

    def deleted_text(self, text, rpr):
        wrapper = self.mark("w:del")
        wrapper.append(new_run(text, rpr, deleted=True))
        return wrapper

    def inserted_text(self, text, rpr):
        wrapper = self.mark("w:ins")
        wrapper.append(new_run(text, rpr))
        return wrapper

    def mark_paragraph(self, paragraph, tag):
        """Marks the paragraph mark as inserted (w:ins) or deleted (w:del)."""
        from docx.oxml import OxmlElement

        ppr = paragraph.find(w("pPr"))
        if ppr is None:
            ppr = OxmlElement("w:pPr")
            paragraph.insert(0, ppr)
        rpr = ppr.find(w("rPr"))
        if rpr is None:
            rpr = OxmlElement("w:rPr")
            sect = ppr.find(w("sectPr"))
            change = ppr.find(w("pPrChange"))
            if sect is not None:
                sect.addprevious(rpr)
            elif change is not None:
                change.addprevious(rpr)
            else:
                ppr.append(rpr)
        rpr.insert(0, self.mark(tag))

    def replace(self, paragraph, start, end, text):
        """Tracked replacement of live text [start, end) by `text`."""
        rpr = rpr_at(paragraph, start)
        runs = runs_in(paragraph, start, end) if end > start else []
        if not runs:
            if text:
                inserted = self.inserted_text(text, rpr)
                place(paragraph, start, inserted)
                self.lift(inserted)
            return
        self.delete_runs(runs)
        if text:
            # Each deleted run sits in its own w:del: the new text follows the last.
            inserted = self.inserted_text(text, rpr)
            runs[-1].getparent().addnext(inserted)
            self.lift(inserted)

    def lift(self, inserted):
        """Moves our w:ins out of another author's w:ins, splitting it there, as Word does.

        Text typed into someone's tracked insertion is a separate insertion
        between two halves of theirs; nested insertions would make rejecting
        theirs also drop ours, and Word does not write them.
        """
        parent = inserted.getparent()
        while parent is not None and parent.tag == w("ins"):
            following = list(inserted.itersiblings())
            if following:
                rest = copy.deepcopy(parent)
                for child in list(rest):
                    rest.remove(child)
                rest.set(w("id"), str(self.next_id))
                self.next_id += 1
                for child in following:
                    rest.append(child)
                parent.addnext(rest)
            parent.addnext(inserted)
            if len(parent) == 0:
                parent.getparent().remove(parent)
            parent = inserted.getparent()


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- fill


def replace_plain(paragraph, start, end, value, underline=False):
    """Untracked replacement: the first run keeps its formatting and gets the value."""
    from docx.oxml import OxmlElement

    runs = runs_in(paragraph, start, end)
    if not runs:
        return
    first = runs[0]
    for child in [c for c in first if c.tag != w("rPr")]:
        if piece_text(child) is not None:
            first.remove(child)
    for child in text_children(value):
        first.append(child)
    for run in runs[1:]:
        run.getparent().remove(run)
    if underline:
        rpr = first.find(w("rPr"))
        if rpr is None:
            rpr = OxmlElement("w:rPr")
            first.insert(0, rpr)
        if rpr.find(w("u")) is None:
            u = OxmlElement("w:u")
            u.set(w("val"), "single")
            rpr.append(u)


def placeholder_pattern(key):
    escaped = re.escape(key)
    return re.compile(r"\{\{\s*" + escaped + r"\s*\}\}|\{" + escaped + r"\}")


def fill_document(path, values, output):
    document = open_document(path)
    roots = text_parts(document)
    paragraphs = list(all_paragraphs(roots))
    replaced = {}
    for key, value in values.items():
        pattern = placeholder_pattern(key)
        text_value = value_text(value)
        for paragraph in paragraphs:
            text = paragraph_text(paragraph)
            matches = list(pattern.finditer(text))
            for match in reversed(matches):
                replace_plain(paragraph, match.start(), match.end(), text_value)
            if matches:
                replaced[key] = replaced.get(key, 0) + len(matches)
    blanks = []
    for key, value in values.items():
        if key in replaced:
            continue
        label = re.compile(re.escape(key), re.I)
        for paragraph in paragraphs:
            text = paragraph_text(paragraph)
            found = label.search(text)
            blank = BLANK.search(text, found.end()) if found else None
            if blank:
                replace_plain(paragraph, blank.start(), blank.end(), value_text(value), underline=True)
                replaced[key] = 1
                blanks.append(key)
                break
    left = sorted({m.group(0) for p in paragraphs for m in PLACEHOLDER_LEFT.finditer(paragraph_text(p))})
    out_path(output, path)
    document.save(output)
    return {
        "output": output,
        "replaced": replaced,
        "blanks": blanks,
        "unknown": [key for key in values if key not in replaced],
        "left": left,
    }


def value_text(value):
    if value is True:
        return "☑"
    if value is False:
        return "☐"
    if value is None:
        return ""
    return str(value)


def fill(argv):
    p = parser("docx fill")
    p.add_argument("template")
    p.add_argument("values")
    p.add_argument("-o", "--output", required=True)
    args = p.parse_args(argv)
    values = read_json(args.values)
    if isinstance(values, dict):
        return fill_document(args.template, values, args.output)
    if not isinstance(values, list) or not all(isinstance(item, dict) for item in values) or not values:
        raise KitError("bad_values", "VALUES.json must be an object or a list of objects")
    if len(values) > 1000:
        raise KitError("too_many", "more than 1000 documents in one call")
    if os.path.splitext(args.output)[1].lower() == ".docx":
        raise KitError("bad_output", "with a list of values -o is a directory", "-o /workspace/out/gramoty")
    os.makedirs(args.output, exist_ok=True)
    files = []
    used = set()
    for n, item in enumerate(values, 1):
        item = dict(item)
        name = str(item.pop("_file", "") or "%03d.docx" % n)
        # One path component Linux can store (255 bytes; Cyrillic takes two).
        stem = re.sub(r"[/\\\x00]+", "_", name)
        if stem.lower().endswith(".docx"):
            stem = stem[:-5]
        stem = stem[:100] or "%03d" % n
        name = stem + ".docx"
        copy_number = 2
        while name.lower() in used:
            # Two rows with the same _file must not overwrite each other.
            name = "%s (%d).docx" % (stem, copy_number)
            copy_number += 1
        used.add(name.lower())
        files.append(fill_document(args.template, item, os.path.join(args.output, name)))
    return {"output": args.output, "files": files}


# ---------------------------------------------------------------- edit


def matching(paragraphs, regex):
    try:
        pattern = re.compile(regex)
    except re.error as error:
        raise KitError("bad_edits", "bad regex %r: %s" % (regex, error))
    return [p for p in paragraphs if pattern.search(paragraph_text(p))]


def body_paragraphs(document):
    return list(document.element.body.iter(w("p")))


def clean_ppr(ppr, keep_numbering):
    ppr = copy.deepcopy(ppr)
    for tag in ("sectPr", "pPrChange", "rPr"):
        for item in ppr.findall(w(tag)):
            ppr.remove(item)
    if not keep_numbering:
        for item in ppr.findall(w("numPr")):
            ppr.remove(item)
    return ppr


def insert_after(revisions, anchor, text, same_numbering):
    from docx.oxml import OxmlElement

    ppr = anchor.find(w("pPr"))
    first_run = next(iter(runs_of(anchor)), None)
    rpr = run_properties(first_run)
    previous = anchor
    added = []
    for line in text.split("\n"):
        paragraph = OxmlElement("w:p")
        if ppr is not None:
            paragraph.append(clean_ppr(ppr, same_numbering))
        if line:
            paragraph.append(revisions.inserted_text(line, rpr))
        revisions.mark_paragraph(paragraph, "w:ins")
        previous.addnext(paragraph)
        previous = paragraph
        added.append(paragraph)
    return added


def delete_paragraph(revisions, paragraph):
    revisions.delete_runs(runs_of(paragraph))
    revisions.mark_paragraph(paragraph, "w:del")


def apply_edit(document, roots, revisions, edit):
    if not isinstance(edit, dict) or len(edit) != 1:
        raise KitError("bad_edits", "each edit is one of replace, insert_after, replace_all, delete_paragraph")
    op, spec = next(iter(edit.items()))
    if not isinstance(spec, dict):
        raise KitError("bad_edits", op + " needs an object")
    if op == "replace":
        old, new = str(spec.get("old", "")), str(spec.get("new", ""))
        if not old:
            raise KitError("bad_edits", "replace needs old")
        candidates = matching(all_paragraphs(roots), spec.get("in_paragraph", re.escape(old)))
        for paragraph in candidates:
            at = paragraph_text(paragraph).find(old)
            if at >= 0:
                revisions.replace(paragraph, at, at + len(old), new)
                return op, "ok", 1
        return op, "not_found", 0
    if op == "replace_all":
        old, new = str(spec.get("old", "")), str(spec.get("new", ""))
        if not old:
            raise KitError("bad_edits", "replace_all needs old")
        count = 0
        for paragraph in list(all_paragraphs(roots)):
            text = paragraph_text(paragraph)
            positions = [m.start() for m in re.finditer(re.escape(old), text)]
            for at in reversed(positions):
                revisions.replace(paragraph, at, at + len(old), new)
            count += len(positions)
        return op, "ok" if count else "not_found", count
    if op == "insert_after":
        text = str(spec.get("text", ""))
        if not text.strip():
            raise KitError("bad_edits", "insert_after needs text")
        anchors = matching(body_paragraphs(document), spec.get("anchor", "^$"))
        if not anchors:
            return op, "not_found", 0
        insert_after(revisions, anchors[0], text, bool(spec.get("same_numbering", True)))
        return op, "ok", 1
    if op == "delete_paragraph":
        anchors = matching(body_paragraphs(document), spec.get("anchor", "^$"))
        if not anchors:
            return op, "not_found", 0
        delete_paragraph(revisions, anchors[0])
        return op, "ok", 1
    raise KitError("bad_edits", "unknown edit: " + op, "replace, insert_after, replace_all, delete_paragraph")


def edit(argv):
    p = parser("docx edit")
    p.add_argument("file")
    p.add_argument("edits")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--author", default="Бро")
    p.add_argument("--date")
    args = p.parse_args(argv)
    edits = read_json(args.edits)
    if not isinstance(edits, list) or not edits:
        raise KitError("bad_edits", "EDITS.json must be a list of edits")
    document = open_document(args.file)
    roots = text_parts(document)
    revisions = Revisions(roots, args.author, args.date or now_iso())
    applied = []
    for n, item in enumerate(edits, 1):
        op, status, count = apply_edit(document, roots, revisions, item)
        applied.append({"n": n, "op": op, "status": status, "count": count})
    out_path(args.output, args.file)
    document.save(args.output)
    return {
        "output": args.output,
        "applied": applied,
        "not_found": [a["n"] for a in applied if a["status"] == "not_found"],
        "insertions": revisions.insertions,
        "deletions": revisions.deletions,
    }


# ---------------------------------------------------------------- compare


def blocks(container):
    """Block children (paragraphs, tables, content controls) of a body or cell."""
    return [child for child in container if child.tag in (w("p"), w("tbl"), w("sdt"))]


def block_key(element):
    if element.tag == w("p"):
        return "p:" + normal(paragraph_text(element))
    return element.tag.split("}")[1] + ":" + normal(" ".join(paragraph_text(p) for p in element.iter(w("p"))))


def normal(text):
    return re.sub(r"\s+", " ", text).strip()


def table_shape(table):
    return [len(row.findall(w("tc"))) for row in table.findall(w("tr"))]


class Redline:
    def __init__(self, revisions, b_document):
        self.revisions = revisions
        self.changes = []
        self.changed_paragraphs = 0
        self.unsupported = []
        self.numbering = set()
        self.styles = set()
        try:
            numbering = b_document.part.numbering_part.element
            self.numbering = {n.get(w("numId")) for n in numbering.findall(w("num"))}
        except (KeyError, NotImplementedError, AttributeError):
            pass
        self.styles = {s.get(w("styleId")) for s in b_document.styles.element.findall(w("style"))}

    def note(self, kind, old, new):
        self.changed_paragraphs += 1
        if len(self.changes) < MAX_CHANGES_LISTED:
            self.changes.append({"kind": kind, "old": old[:300], "new": new[:300]})

    def diff_blocks(self, a_container, b_container, end_anchor=None):
        a_blocks, b_blocks = blocks(a_container), blocks(b_container)
        a_keys, b_keys = [block_key(b) for b in a_blocks], [block_key(b) for b in b_blocks]
        matcher = difflib.SequenceMatcher(None, a_keys, b_keys, autojunk=False)
        for tag, i1, i2, j1, j2 in reversed(matcher.get_opcodes()):
            if tag == "equal":
                continue
            before = b_blocks[j2] if j2 < len(b_blocks) else None
            self.region(a_blocks[i1:i2], b_blocks[j1:j2], before, b_container, end_anchor)

    def region(self, a_items, b_items, before, b_container, end_anchor):
        """Pairs similar blocks in order; the rest become deletions and insertions."""
        pairs = []
        j = 0
        for i, a in enumerate(a_items):
            best, best_ratio = None, 0.5
            for k in range(j, len(b_items)):
                ratio = similarity(a, b_items[k])
                if ratio > best_ratio:
                    best, best_ratio = k, ratio
            if best is not None:
                pairs.append((i, best))
                j = best + 1
        paired_a = {i for i, _ in pairs}
        paired_b = {k for _, k in pairs}
        # Walk B's items, placing each unpaired A item before the B item that
        # follows its paired predecessor.
        next_b_for_a = {}
        last_k = -1
        pair_of_a = dict(pairs)
        for i in range(len(a_items)):
            if i in pair_of_a:
                last_k = pair_of_a[i]
            else:
                next_b_for_a[i] = last_k + 1
        for i, k in pairs:
            self.pair(a_items[i], b_items[k])
        for k, b in enumerate(b_items):
            if k not in paired_b:
                self.inserted_block(b)
        for i, a in enumerate(a_items):
            if i in paired_a:
                continue
            k = next_b_for_a[i]
            anchor = b_items[k] if k < len(b_items) else before
            self.deleted_block(a, anchor, b_container, end_anchor)

    def pair(self, a, b):
        if a.tag == w("p") and b.tag == w("p"):
            self.word_diff(a, b)
        elif a.tag == w("tbl") and b.tag == w("tbl") and table_shape(a) == table_shape(b):
            for a_row, b_row in zip(a.findall(w("tr")), b.findall(w("tr"))):
                for a_cell, b_cell in zip(a_row.findall(w("tc")), b_row.findall(w("tc"))):
                    self.diff_blocks(a_cell, b_cell)
        else:
            self.unsupported.append("a changed %s is left as in B without marks" % b.tag.split("}")[1])

    def word_diff(self, a, b):
        a_text, b_text = paragraph_text(a), paragraph_text(b)
        if a_text == b_text:
            return
        for a0, a1, b0, b1 in reversed(text_changes(a_text, b_text)):
            old = a_text[a0:a1]
            rpr = rpr_at(b, b0)
            if b1 > b0:
                self.revisions.insert_runs(runs_in(b, b0, b1))
            if old:
                place(b, b0, self.revisions.deleted_text(old, rpr))
        self.note("changed", a_text, b_text)

    def inserted_block(self, b):
        if b.tag != w("p"):
            for paragraph in list(b.iter(w("p"))):
                self.revisions.insert_runs(runs_of(paragraph))
                self.revisions.mark_paragraph(paragraph, "w:ins")
            self.unsupported.append("an inserted %s: its text is marked, its structure is not" % b.tag.split("}")[1])
            return
        self.revisions.insert_runs(runs_of(b))
        self.revisions.mark_paragraph(b, "w:ins")
        self.note("inserted", "", paragraph_text(b))

    def deleted_block(self, a, anchor, b_container, end_anchor):
        if a.tag != w("p"):
            self.unsupported.append("a deleted %s is not shown in the redline" % a.tag.split("}")[1])
            return
        copy_ = self.portable(a)
        self.revisions.delete_runs(runs_of(copy_))
        self.revisions.mark_paragraph(copy_, "w:del")
        if anchor is not None:
            anchor.addprevious(copy_)
        elif end_anchor is not None:
            end_anchor.addprevious(copy_)
        else:
            b_container.append(copy_)
        self.note("deleted", paragraph_text(a), "")

    def portable(self, paragraph):
        """A copy of A's paragraph that B's package can hold (no foreign ids)."""
        copy_ = copy.deepcopy(paragraph)
        for tag in ("drawing", "pict", "object"):
            for item in list(copy_.iter(w(tag))):
                item.getparent().remove(item)
        for link in list(copy_.iter(w("hyperlink"))):
            parent = link.getparent()
            index = parent.index(link)
            for child in list(link):
                parent.insert(index, child)
                index += 1
            parent.remove(link)
        for item in list(copy_.iter()):
            for attribute in list(item.attrib):
                if attribute.startswith("{%s}" % R_NS):
                    del item.attrib[attribute]
        ppr = copy_.find(w("pPr"))
        if ppr is not None:
            for sect in ppr.findall(w("sectPr")):
                ppr.remove(sect)
            num = ppr.find(w("numPr"))
            if num is not None:
                num_id = num.find(w("numId"))
                if num_id is None or num_id.get(w("val")) not in self.numbering:
                    ppr.remove(num)
            style = ppr.find(w("pStyle"))
            if style is not None and style.get(w("val")) not in self.styles:
                ppr.remove(style)
        for run in copy_.iter(w("r")):
            style = run.find("%s/%s" % (w("rPr"), w("rStyle")))
            if style is not None and style.get(w("val")) not in self.styles:
                style.getparent().remove(style)
        return copy_


def offsets(tokens):
    starts = [0]
    for token in tokens:
        starts.append(starts[-1] + len(token))
    return starts


def text_changes(a_text, b_text):
    """[(a0, a1, b0, b1)] character spans that differ, by words or by sentences.

    Changes separated only by whitespace merge into one, as a person reads them.
    """
    a_words, b_words = WORD.findall(a_text), WORD.findall(b_text)
    matcher = difflib.SequenceMatcher(None, a_words, b_words, autojunk=False)
    if matcher.ratio() < WORD_DIFF_MIN_RATIO:
        a_words, b_words = SENTENCE.findall(a_text), SENTENCE.findall(b_text)
        matcher = difflib.SequenceMatcher(None, a_words, b_words, autojunk=False)
    a_starts, b_starts = offsets(a_words), offsets(b_words)
    spans = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            if spans and spans[-1][1] == i1 and all(not t.strip() for t in a_words[i1:i2]) and i2 < len(a_words):
                spans[-1][1] = i2
                spans[-1][3] = j2
            continue
        if spans and spans[-1][1] == i1 and spans[-1][3] == j1:
            spans[-1][1], spans[-1][3] = i2, j2
        else:
            spans.append([i1, i2, j1, j2])
    out = []
    for i1, i2, j1, j2 in spans:
        a0, a1, b0, b1 = a_starts[i1], a_starts[i2], b_starts[j1], b_starts[j2]
        # A whitespace gap swallowed at the end belongs to the text that follows.
        while a1 > a0 and b1 > b0 and a_text[a1 - 1] == b_text[b1 - 1] and a_text[a1 - 1].isspace():
            a1, b1 = a1 - 1, b1 - 1
        out.append((a0, a1, b0, b1))
    return out


def similarity(a, b):
    if a.tag != b.tag:
        return 0.0
    key_a, key_b = block_key(a), block_key(b)
    if a.tag == w("tbl"):
        return 0.99 if table_shape(a) == table_shape(b) else 0.0
    return difflib.SequenceMatcher(None, TOKEN.findall(key_a), TOKEN.findall(key_b), autojunk=False).ratio()


def compare(argv):
    p = parser("docx compare")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--author", default="Бро")
    p.add_argument("--date")
    args = p.parse_args(argv)
    a_document = open_document(args.a)
    b_document = open_document(args.b)
    revisions = Revisions(text_parts(b_document), args.author, args.date or now_iso())
    redline = Redline(revisions, b_document)
    body = b_document.element.body
    redline.diff_blocks(a_document.element.body, body, end_anchor=body.find(w("sectPr")))
    out_path(args.output, args.a, args.b)
    b_document.save(args.output)
    return {
        "output": args.output,
        "insertions": revisions.insertions,
        "deletions": revisions.deletions,
        "changed_paragraphs": redline.changed_paragraphs,
        "changes": redline.changes,
        "unsupported": sorted(set(redline.unsupported)),
    }


# ---------------------------------------------------------------- text


def revision_text(paragraph, mode):
    """(text, mark) of a paragraph under accept / reject / show; mark False = merge with the next."""

    # A run carries both marks when one change sits in another (text deleted
    # from someone's insertion): accepting drops what is deleted, rejecting
    # drops what is inserted.
    def walk(element, inserted, deleted):
        for child in element:
            tag = child.tag
            if tag == w("r"):
                yield inserted, deleted, "".join(piece_text(c) or "" for c in child)
            elif tag in (w("ins"), w("moveTo")):
                yield from walk(child, True, deleted)
            elif tag in DELETED:
                yield from walk(child, inserted, True)
            elif tag in RUN_CONTAINERS:
                yield from walk(child, inserted, deleted)

    out = []
    for inserted, deleted, text in walk(paragraph, False, False):
        if not text:
            continue
        if mode == "accept":
            if not deleted:
                out.append(text)
        elif mode == "reject":
            if not inserted:
                out.append(text)
        elif deleted:
            out.append("[-%s-]" % text)
        elif inserted:
            out.append("{+%s+}" % text)
        else:
            out.append(text)
    mark = True
    rpr = paragraph.find("%s/%s" % (w("pPr"), w("rPr")))
    if rpr is not None:
        if mode == "accept" and rpr.find(w("del")) is not None:
            mark = False
        if mode == "reject" and rpr.find(w("ins")) is not None:
            mark = False
    return "".join(out), mark


def document_text(document, mode):
    lines = []
    carry = ""

    def visit(container):
        nonlocal carry
        for child in container:
            if child.tag == w("p"):
                text, mark = revision_text(child, mode)
                carry += text
                if mark:
                    lines.append(carry)
                    carry = ""
            elif child.tag == w("tbl"):
                for row in child.findall(w("tr")):
                    cells = []
                    for cell in row.findall(w("tc")):
                        saved = len(lines)
                        visit(cell)
                        cells.append(" / ".join(line for line in lines[saved:] if line))
                        del lines[saved:]
                    lines.append(" | ".join(cells))
            elif child.tag == w("sdt"):
                content = child.find(w("sdtContent"))
                if content is not None:
                    visit(content)

    visit(document.element.body)
    if carry:
        lines.append(carry)
    return "\n".join(lines)


def text(argv):
    p = parser("docx text")
    p.add_argument("file")
    p.add_argument("--changes", default="show", choices=("accept", "reject", "show"))
    p.add_argument("-o", "--output")
    args = p.parse_args(argv)
    document = open_document(args.file)
    body = document.element.body
    content = document_text(document, args.changes)
    result = {
        "changes": args.changes,
        "insertions": len(list(body.iter(w("ins")))),
        "deletions": len(list(body.iter(w("del")))),
        "text": content[:TEXT_CHARS],
        "truncated": len(content) > TEXT_CHARS,
        "chars": len(content),
    }
    if args.output:
        out_path(args.output, args.file)
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(content)
        result["output"] = args.output
    return result
