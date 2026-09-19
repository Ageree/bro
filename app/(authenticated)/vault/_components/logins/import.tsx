"use client";

import {
  ExternalLinkIcon,
  FileKeyIcon,
  ShieldCheckIcon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import {
  loginIdentifierSchema,
  serializeLoginVaultPayload,
  type VaultImportItems,
} from "@shared/vault/schema";
import { api } from "@web/trpc/client";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const GOOGLE_PASSWORD_MANAGER_URL = "https://passwords.google.com/options";

export function ChromeImportPanel({ onDone }: { readonly onDone: () => void }) {
  const router = useRouter();
  const importPasswords = api.vault.import.useMutation();
  const [selection, setSelection] =
    useState<ReturnType<typeof parseChromePasswordsCsv>>();
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string>();
  const [importedCount, setImportedCount] = useState<number>();
  const [inputKey, setInputKey] = useState(0);

  const chooseFile = async (file?: File) => {
    importPasswords.reset();
    setError(undefined);
    setImportedCount(undefined);
    setSelection(undefined);
    setFileName(file?.name ?? "");
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setError("Выбери CSV меньше 10 МБ.");
      return;
    }

    try {
      setSelection(parseChromePasswordsCsv(await file.text()));
    } catch (parseError) {
      setError(
        parseError instanceof Error
          ? parseError.message
          : "Этот CSV не прочитать."
      );
    }
  };

  const importSelectedPasswords = () => {
    if (!selection) return;
    setError(undefined);
    const count = selection.items.length;
    importPasswords.mutate(selection.items, {
      onSuccess: () => {
        router.refresh();
        setSelection(undefined);
        setImportedCount(count);
        setFileName("");
        setInputKey((key) => key + 1);
      },
    });
  };

  const reset = () => {
    importPasswords.reset();
    setSelection(undefined);
    setFileName("");
    setError(undefined);
    setImportedCount(undefined);
    setInputKey((key) => key + 1);
  };
  const importError =
    error ??
    (importPasswords.error
      ? "Импорт не завершился. Посмотри ошибку сейфа и попробуй ещё раз."
      : undefined);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Импорт паролей из Chrome</DialogTitle>
        <DialogDescription>
          Выгрузи CSV из Google Password Manager и выбери его здесь. Пароли
          лягут в зашифрованный сейф этого кабинета.
        </DialogDescription>
      </DialogHeader>

      {importedCount === undefined ? (
        <div className="grid gap-5">
          <div className="grid gap-2">
            <p className="type-row">1. Выгрузи пароли</p>
            <p className="type-fine text-muted-foreground">
              Открой настройки Google Password Manager и выбери «Экспорт
              паролей».
            </p>
            <Button
              nativeButton={false}
              render={
                <a
                  aria-label="Открыть Google Password Manager"
                  href={GOOGLE_PASSWORD_MANAGER_URL}
                  rel="noreferrer"
                  target="_blank"
                />
              }
              variant="act"
            >
              Открыть Google Password Manager
              <ExternalLinkIcon />
            </Button>
          </div>

          <div className="grid gap-2">
            <Label className="type-row" htmlFor="chrome-passwords-csv">
              2. Выбери выгруженный CSV
            </Label>
            <Input
              accept=".csv,text/csv"
              disabled={importPasswords.isPending}
              id="chrome-passwords-csv"
              key={inputKey}
              onChange={(event) =>
                void chooseFile(event.currentTarget.files?.[0])
              }
              type="file"
              variant="paper"
            />
            {selection ? (
              <p className="type-fine text-muted-foreground">
                Готово к импорту:{" "}
                {selection.items.length.toLocaleString("ru-RU")} из {fileName}
                {selection.skipped > 0
                  ? ` · пропущено строк с ошибками: ${selection.skipped.toLocaleString("ru-RU")}`
                  : ""}
              </p>
            ) : null}
          </div>

          {importError ? (
            <Alert variant="destructive">
              <FileKeyIcon />
              <AlertTitle>Не вышло импортировать этот файл</AlertTitle>
              <AlertDescription>{importError}</AlertDescription>
            </Alert>
          ) : null}

          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>Пароли остаются в твоём сейфе</AlertTitle>
            <AlertDescription>
              CSV читается в этом браузере и никуда не выгружается. Chrome
              экспортирует пароли открытым текстом, так что удали файл после
              импорта.
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>
            Импортировано входов: {importedCount.toLocaleString("ru-RU")}
          </AlertTitle>
          <AlertDescription>
            Теперь Bro берёт их из зашифрованного сейфа. Удали выгруженный CSV с
            устройства.
          </AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        {importedCount === undefined ? (
          <Button
            disabled={importPasswords.isPending || !selection}
            onClick={importSelectedPasswords}
            type="button"
            variant="paper"
          >
            <UploadIcon />
            {importPasswords.isPending
              ? "Импортируем…"
              : selection
                ? `Импортировать: ${selection.items.length.toLocaleString("ru-RU")}`
                : "Выбери CSV"}
          </Button>
        ) : (
          <Button
            onClick={() => {
              reset();
              onDone();
            }}
            type="button"
            variant="paper"
          >
            Готово
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function parseChromePasswordsCsv(csv: string) {
  const rows = parseCsv(csv);
  const headers = rows.shift()?.map((header) =>
    header
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
  );
  if (!headers) throw new Error("Выбери CSV с паролями из Chrome.");

  const indexes = {
    name: headers.indexOf("name"),
    password: headers.indexOf("password"),
    url: headers.indexOf("url"),
    username: headers.indexOf("username"),
  };
  if (indexes.url < 0 || indexes.username < 0 || indexes.password < 0) {
    throw new Error(
      "В этом CSV нужны колонки url, username и password. Выгрузи его из Google Password Manager и попробуй ещё раз."
    );
  }

  const items: VaultImportItems = [];
  let skipped = 0;

  for (const row of rows) {
    if (row.every((value) => value.length === 0)) continue;

    const account = row[indexes.username]?.trim() ?? "";
    const password = row[indexes.password] ?? "";
    const url = row[indexes.url]?.trim() ?? "";
    const origin = originFromUrl(url);
    const name = indexes.name >= 0 ? row[indexes.name]?.trim() : undefined;
    const label = name?.length ? name : labelFromUrl(url);

    if (
      !label ||
      !origin ||
      account.length === 0 ||
      password.length === 0 ||
      account.length > 300 ||
      label.length > 120 ||
      password.length > 20_000
    ) {
      skipped += 1;
      continue;
    }

    items.push({
      account: "",
      kind: "login",
      label,
      secret: serializeLoginVaultPayload({
        authentication: { password, type: "password" },
        identifier: {
          type: loginIdentifierSchema.safeParse({
            type: "email",
            value: account,
          }).success
            ? "email"
            : "username",
          value: account,
        },
        kind: "login",
        origin,
        version: 2,
      }),
    });
  }

  if (items.length === 0) {
    throw new Error("В этом CSV не нашлось ни одного сохранённого пароля.");
  }
  if (items.length > 3_000) {
    throw new Error(
      `В этом файле паролей: ${items.length.toLocaleString("ru-RU")}. За раз можно импортировать до ${(3_000).toLocaleString("ru-RU")}.`
    );
  }

  return { items, skipped };
}

function labelFromUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "") || value;
  } catch {
    return value.slice(0, 120);
  }
}

function originFromUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCsv(csv: string) {
  const rows: string[][] = [];
  let field = "";
  let quoted = false;
  let row: string[] = [];

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv.charAt(index);
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("В этом CSV не закрыта кавычка.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
