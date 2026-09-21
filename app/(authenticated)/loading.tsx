/** Paper waiting for its ink: the page's own measure, one quiet line. */
export default function Loading() {
  return (
    <div
      aria-label="Страница загружается"
      className="mx-auto w-full max-w-[42rem] px-bro-pad pt-[0.6rem] pb-20"
    >
      <p className="type-fine text-muted-foreground">Загружаем…</p>
    </div>
  );
}
