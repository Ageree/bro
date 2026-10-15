import { Document } from "@web/components/paper/document";

/** Paper waiting for its ink: the page's own measure, one quiet plate. */
export default function Loading() {
  return (
    <Document className="pb-20">
      <output
        aria-label="Страница загружается"
        className="mt-6 block bro-plate p-6 sm:p-8"
      >
        <p className="type-fine text-muted-foreground">Загружаем…</p>
      </output>
    </Document>
  );
}
