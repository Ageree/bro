"""Raster helpers shared by the img commands (numpy and Pillow only)."""

from brokit.util import KitError

MAX_PIXELS = 120_000_000


def load_photo(path, max_side):
    """(RGB image after EXIF transpose, scale) with the long side at most max_side.

    Points the model reads with look are in the photo's own pixels: multiply
    them by `scale` to get pixels of the returned image.
    """
    from PIL import Image, ImageOps, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        image = Image.open(path)
        image.draft("RGB", (max_side, max_side))
        drafted = image.size
        image = ImageOps.exif_transpose(image).convert("RGB")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as error:
        raise KitError("unreadable", "cannot read %s: %s" % (path, type(error).__name__), "send a JPEG or PNG photo")
    with Image.open(path) as original:
        full = original.size
    scale = drafted[0] / full[0]
    if max(image.size) > max_side:
        factor = max_side / max(image.size)
        image = image.resize((round(image.width * factor), round(image.height * factor)), Image.LANCZOS)
        scale *= factor
    return image, scale


def otsu(values):
    import numpy as np

    hist = np.bincount(np.clip(values, 0, 255).astype(np.uint8).ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    weight = np.cumsum(hist)
    mean = np.cumsum(hist * np.arange(256))
    between = (mean[-1] * weight - mean * total) ** 2 / np.maximum(weight * (total - weight), 1)
    return int(np.argmax(between))


def border_connected(mask, step=4):
    """Ink connected to the image border, flooded on a 1/step copy."""
    import numpy as np

    h, w = mask.shape
    hh, ww = h - h % step, w - w % step
    small = mask[:hh, :ww].reshape(hh // step, step, ww // step, step).any(axis=(1, 3))
    seed = np.zeros_like(small)
    seed[0, :], seed[-1, :] = small[0, :], small[-1, :]
    seed[:, 0], seed[:, -1] = small[:, 0], small[:, -1]
    while True:
        grown = seed.copy()
        grown[1:, :] |= seed[:-1, :]
        grown[:-1, :] |= seed[1:, :]
        grown[:, 1:] |= seed[:, :-1]
        grown[:, :-1] |= seed[:, 1:]
        grown &= small
        if np.array_equal(grown, seed):
            break
        seed = grown
    full = np.zeros_like(mask)
    full[:hh, :ww] = np.repeat(np.repeat(seed, step, axis=0), step, axis=1)
    return full & mask


def label_components(mask, limit):
    """8-connected components by row runs and union-find.

    Returns (labels, count) or (None, count) once more than `limit` components
    are certain (a typed page): the caller refuses without the rest.
    """
    import numpy as np

    h, w = mask.shape
    parent = []

    def find(a):
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:
            parent[a], a = root, parent[a]
        return root

    rows, starts, ends, run_labels = [], [], [], []
    previous = []
    padded = np.zeros(w + 2, np.int8)
    for y in range(h):
        padded[1:-1] = mask[y]
        edges = np.diff(padded)
        current = []
        j = 0
        for s, e in zip(np.flatnonzero(edges == 1).tolist(), np.flatnonzero(edges == -1).tolist()):
            label = len(parent)
            parent.append(label)
            # Runs of both rows are sorted: skip those that end before this
            # run can touch them (8-connectivity reaches one column further).
            while j < len(previous) and previous[j][1] < s:
                j += 1
            k = j
            while k < len(previous) and previous[k][0] <= e:
                a, b = find(previous[k][2]), find(label)
                if a != b:
                    parent[b] = a
                k += 1
            current.append((s, e, label))
            rows.append(y)
            starts.append(s)
            ends.append(e)
            run_labels.append(label)
        previous = current
    roots = np.array([find(label) for label in range(len(parent))], dtype=np.int64)
    unique, compact = np.unique(roots, return_inverse=True)
    count = len(unique)
    if count > limit:
        return None, count
    labels = np.zeros((h, w), np.int32)
    run_component = compact[np.array(run_labels, dtype=np.int64)] + 1 if run_labels else []
    for y, s, e, component in zip(rows, starts, ends, run_component):
        labels[y, s:e] = component
    return labels, count


def to_lab(rgb):
    """CIE Lab (D65) of an (..., 3) array of sRGB values 0-255."""
    import numpy as np

    c = np.asarray(rgb, dtype=np.float32) / 255
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    matrix = np.array(
        [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]], dtype=np.float32
    )
    xyz = c @ matrix.T / np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)
