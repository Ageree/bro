/**
 * Group 7 — the person's own files.
 *
 * A file arrives (photo, PDF, receipt), Bro keeps it, and later something is
 * done TO it: OCR, text extraction, a resize. The processing itself happens in
 * a Vercel sandbox, which is unreachable offline — but everything that decides
 * whether the sandbox is even allowed to run, what it may touch, and what comes
 * back, is pure.
 *
 * The rule the whole group is built around is the one in instructions.md that
 * a model will break the moment it is convenient: the sandbox is for FILES, not
 * for the web. A sandbox that can fetch a URL is a second, unmonitored browser
 * with no vault, no live view and no host binding.
 */

import type { Journey } from "./runner.ts";
import { repoText } from "./runner.ts";
import {
  FILE_BINARY_MAX,
  FILE_LIST_LIMIT,
  FILE_NAME_MAX,
  FILE_TEXT_READ_MAX,
  FILE_TEXT_WRITE_MAX,
  sanitizeFileName,
} from "../../../convex/lib/fileStore.ts";
import {
  SANDBOX_NETWORK_RULE,
  sandboxNetworkViolation,
} from "../../../agent/lib/sandbox-policy.ts";
import {
  clipLog,
  safeOutputName,
  SANDBOX_INPUT_MAX_FILES,
  SANDBOX_OUTPUT_MAX_FILES,
  SANDBOX_TIMEOUT_MAX_MS,
} from "../../../agent/lib/sandbox-provider.ts";
import {
  inboundImages,
  isImageContentType,
  IMAGE_MAX_BYTES,
} from "../../../agent/lib/inbound-image.ts";
import { isAudioContentType } from "../../../agent/lib/imessage-text.ts";
import { claimComputerPhoto, claimUrlPhoto, photoFingerprint } from "../../../agent/lib/photo-dedupe.ts";

const INSTRUCTIONS = repoText("agent/instructions.md");
const SANDBOX_TOOL = repoText("agent/tools/sandbox_run.ts");
const FILES_GET_TOOL = repoText("agent/tools/files_get.ts");

/** `sanitizeFileName` throws on a name it refuses — caught so a step can judge. */
function nameOrRefusal(raw: string): string {
  try {
    return sanitizeFileName(raw);
  } catch {
    return "ОТКАЗ";
  }
}

export const FILES: Journey[] = [
  {
    name: "Пришёл PDF → OCR в песочнице → результат сохранён у Bro",
    group: "files",
    steps: [
      {
        it: "файл кладётся под очищенным именем",
        got: () => sanitizeFileName("договор 2026.pdf"),
        want: "договор 2026.pdf",
      },
      {
        it: "тул для обработки прямо называет OCR своей работой",
        got: () => SANDBOX_TOOL,
        contains: "OCR",
      },
      {
        it: "и прямо отделяет себя от сайтов",
        got: () => SANDBOX_TOOL,
        contains: "Not for websites",
      },
      {
        it: "обычный питоновский скрипт без сети разрешён",
        got: () => sandboxNetworkViolation("import pypdf\ntext = pypdf.PdfReader('договор.pdf')"),
        want: null,
      },
      {
        it: "в песочницу можно завести не больше двадцати файлов за раз",
        got: () => SANDBOX_INPUT_MAX_FILES,
        want: 20,
      },
      {
        it: "и она не может крутиться дольше четырёх минут",
        got: () => SANDBOX_TIMEOUT_MAX_MS,
        want: 240_000,
      },
      {
        it: "имя выходного файла схлопывается до базового — путь наружу не собирается",
        got: () => safeOutputName("../../etc/passwd"),
        want: "passwd",
      },
      {
        it: "а имя, которое само по себе поднимается на уровень выше, отвергается",
        got: () => safeOutputName("..жулик"),
        want: null,
      },
      {
        it: "нормальное имя проходит",
        got: () => safeOutputName("договор.txt"),
        want: "договор.txt",
      },
      {
        it: "лог обрезается, а не льётся в ход целиком",
        got: () => clipLog("x".repeat(100_000)).length < 100_000,
        want: true,
      },
      {
        it: "инструкция запрещает обещать, что нужные пакеты уже стоят",
        got: () => INSTRUCTIONS,
        contains: "не обещай, что нужные пакеты уже стоят",
      },
      {
        it: "и запрещает называть человеку песочницу и VM",
        got: () => INSTRUCTIONS,
        contains: "Не называй песочницу",
      },
    ],
  },

  {
    name: "Картинку просят уменьшить — это тоже работа с файлом, а не с сайтом",
    group: "files",
    steps: [
      {
        it: "тул называет ресайз среди своих дел",
        got: () => SANDBOX_TOOL,
        contains: "resize images",
      },
      {
        it: "инструкция говорит то же по-русски",
        got: () => INSTRUCTIONS,
        contains: "уменьшить картинку",
      },
      {
        it: "локальный скрипт ресайза сетевого нарушения не содержит",
        got: () => sandboxNetworkViolation("from PIL import Image\nImage.open('a.jpg').resize((800,600)).save('b.jpg')"),
        want: null,
      },
      {
        it: "результат сохраняется обратно к человеку, а не остаётся в песочнице",
        got: () => INSTRUCTIONS,
        contains: "результат Bro сохраняет сам",
      },
      {
        it: "выходных файлов тоже не больше двадцати",
        got: () => SANDBOX_OUTPUT_MAX_FILES,
        want: 20,
      },
      {
        it: "инструкция прямо предупреждает, что файлы из bash внутри хода пропадают",
        got: () => INSTRUCTIONS,
        contains: "пропадают",
      },
    ],
  },

  {
    name: "Файла нет — это отдельный ответ, а не молчание и не выдумка",
    group: "files",
    steps: [
      {
        it: "тул чтения требует назвать файл — id или имя",
        got: () => FILES_GET_TOOL,
        contains: "fileId or name required",
      },
      {
        it: "и у отказа есть свой статус, а не общий «error»",
        got: () => FILES_GET_TOOL,
        contains: 'status: "invalid"',
      },
      {
        it: "ошибка файла возвращается ходу как результат, а не как исключение",
        got: () => FILES_GET_TOOL,
        contains: "fileFailure(err)",
      },
      {
        it: "песочница на отсутствующем файле останавливается с понятным текстом",
        got: () => repoText("agent/lib/sandbox-run.ts"),
        contains: "file not found",
      },
      {
        it: "и на слишком большом — тоже",
        got: () => repoText("agent/lib/sandbox-run.ts"),
        contains: "exceeds 8MB",
      },
    ],
  },

  {
    name: "Имя файла из чата пытается вылезти из хранилища",
    group: "files",
    steps: [
      {
        it: "путь схлопывается до имени",
        got: () => nameOrRefusal("/etc/passwd"),
        want: "passwd",
      },
      {
        it: "обратные слэши тоже",
        got: () => nameOrRefusal("C:\\Windows\\system32\\config"),
        want: "config",
      },
      {
        it: "две точки не переживают чистку",
        got: () => nameOrRefusal(".."),
        want: "ОТКАЗ",
      },
      {
        it: "пустое имя тоже",
        got: () => nameOrRefusal("   "),
        want: "ОТКАЗ",
      },
      {
        it: "перевод строки в имени вырезается",
        got: () => nameOrRefusal("счёт\n.pdf"),
        want: "счёт.pdf",
      },
      {
        it: "длина имени ограничена",
        got: () => nameOrRefusal("а".repeat(500)).length,
        want: FILE_NAME_MAX,
      },
      {
        it: "кириллица при этом остаётся именем, а не превращается в мусор",
        got: () => nameOrRefusal("отчёт за сентябрь.xlsx"),
        want: "отчёт за сентябрь.xlsx",
      },
    ],
  },

  {
    name: "Из песочницы пробуют сходить в интернет",
    group: "files",
    steps: [
      {
        it: "curl запрещён",
        got: () => sandboxNetworkViolation("curl https://wildberries.ru"),
        want: SANDBOX_NETWORK_RULE,
      },
      {
        it: "requests — тоже",
        got: () => sandboxNetworkViolation("import requests"),
        want: SANDBOX_NETWORK_RULE,
      },
      {
        it: "и playwright, чтобы песочница не стала вторым браузером",
        got: () => sandboxNetworkViolation("from playwright.sync_api import sync_playwright"),
        want: SANDBOX_NETWORK_RULE,
      },
      {
        it: "и fetch из JS",
        got: () => sandboxNetworkViolation("await fetch('https://example.com')"),
        want: SANDBOX_NETWORK_RULE,
      },
      {
        it: "правило само называет, куда идти вместо этого",
        got: () => SANDBOX_NETWORK_RULE,
        contains: "browser_task",
      },
      {
        it: "собственный API Composio остаётся разрешённым — там живёт постобработка",
        got: () => sandboxNetworkViolation("requests_url = 'https://api.composio.dev/v1/x'"),
        want: null,
      },
      {
        it: "пустой код нарушением не считается",
        got: () => sandboxNetworkViolation(""),
        want: null,
      },
    ],
  },

  {
    name: "Входящее фото: Bro его узнаёт, а не просит прислать текстом",
    group: "files",
    steps: [
      {
        it: "картинка отличается от прочих вложений по типу",
        got: () => [isImageContentType("image/jpeg"), isImageContentType("application/pdf")],
        want: [true, false],
      },
      {
        it: "из вложений выбираются только картинки",
        got: () =>
          inboundImages([
            { url: "https://x/a.jpg", content_type: "image/jpeg", size: 1000 },
            { url: "https://x/b.pdf", content_type: "application/pdf", size: 1000 },
          ]).map((i) => i.url),
        want: ["https://x/a.jpg"],
      },
      {
        it: "тип нормализуется — параметры charset в модель не едут",
        got: () =>
          inboundImages([{ url: "https://x/a.jpg", content_type: "image/JPEG; charset=binary" }])[0]?.mediaType,
        want: "image/jpeg",
      },
      {
        it: "вложение без ссылки не картинка",
        got: () => inboundImages([{ url: "  ", content_type: "image/jpeg" }]),
        want: [],
      },
      {
        it: "голосовое вложение картинкой не считается",
        got: () => [isAudioContentType("audio/m4a"), isImageContentType("audio/m4a")],
        want: [true, false],
      },
      {
        it: "большие картинки в ход целиком не встраиваются — есть потолок",
        got: () => IMAGE_MAX_BYTES,
        want: 3 * 1024 * 1024,
      },
      {
        it: "инструкция запрещает просить прислать текстом то, что видно на фото",
        got: () => INSTRUCTIONS,
        contains: "не проси прислать текстом",
      },
    ],
  },

  {
    name: "Одно фото — один пузырь: повтор не уходит четыре раза",
    group: "files",
    steps: [
      {
        it: "отпечаток одинаковых байтов совпадает",
        got: () =>
          photoFingerprint(new Uint8Array([1, 2, 3, 4])) === photoFingerprint(new Uint8Array([1, 2, 3, 4])),
        want: true,
      },
      {
        it: "разных — нет",
        got: () =>
          photoFingerprint(new Uint8Array([1, 2, 3, 4])) === photoFingerprint(new Uint8Array([9, 9, 9, 9])),
        want: false,
      },
      {
        it: "первая отправка проходит",
        got: () =>
          claimComputerPhoto({
            chatKey: "journeys-photo",
            bytes: new Uint8Array([1, 2, 3, 4]),
            now: 1_000,
          }),
        want: true,
      },
      {
        it: "тот же кадр секундой позже — нет",
        got: () =>
          claimComputerPhoto({
            chatKey: "journeys-photo",
            bytes: new Uint8Array([1, 2, 3, 4]),
            now: 2_000,
          }),
        want: false,
      },
      {
        it: "ссылка на фото дедуплицируется отдельно",
        got: () => claimUrlPhoto({ chatKey: "journeys-url", url: "https://x/a.jpg", now: 1_000 }),
        want: true,
      },
      {
        it: "и повторная ссылка не уходит",
        got: () => claimUrlPhoto({ chatKey: "journeys-url", url: "https://x/a.jpg", now: 2_000 }),
        want: false,
      },
      {
        it: "инструкция запрещает отвечать «не могу вложить»",
        got: () => INSTRUCTIONS,
        contains: "Никогда не пиши «не могу вложить»",
      },
    ],
  },

  {
    name: "Границы хранилища названы числами, а не «ну примерно»",
    group: "files",
    steps: [
      {
        it: "бинарный файл — до восьми мегабайт",
        got: () => FILE_BINARY_MAX,
        want: 8 * 1024 * 1024,
      },
      {
        it: "текст на запись — до двухсот пятидесяти шести килобайт",
        got: () => FILE_TEXT_WRITE_MAX,
        want: 256 * 1024,
      },
      {
        it: "на чтение в ход — меньше, чтобы не забить контекст",
        got: () => FILE_TEXT_READ_MAX < FILE_TEXT_WRITE_MAX,
        want: true,
      },
      {
        it: "список файлов ограничен сотней",
        got: () => FILE_LIST_LIMIT,
        want: 100,
      },
      {
        it: "тул чтения честно говорит, что большой файл вернётся метаданными",
        got: () => FILES_GET_TOOL,
        contains: "larger or binary files get metadata",
      },
    ],
  },
];
