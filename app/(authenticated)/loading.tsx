import { Document } from "@web/components/paper/document";

/** Paper waiting for its ink: the page's own measure, one quiet plate. */
export default function Loading() {
  return (
    <Document className="pb-20">
      <div
        aria-label="Страница загружается"
        className="mt-6 bro-plate p-6 sm:p-8"
        role="status"
      >
        <p className="type-fine text-muted-foreground">Загружаем…</p>
      </div>
    </Document>
  );
}
