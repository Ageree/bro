# P2 — Browser follow-through (Bro пишет первым, когда джоб готов)

Контекст: в репо уже есть примитив wakeups (convex/wakeups.ts, роут
POST /internal/wakeup в agent/channels/imessage.ts, agent/lib/convex.ts:
scheduleWakeup/cancelWakeup). Прочитай их + agent/tools/browser_task.ts +
agent/lib/browser-policy.ts + convex/lib/wakeupPolicy.ts перед работой.
Стиль: минимальный код, идиомы репо, без новых зависимостей. Не трогай
vendor/, convex/_generated/.

## Проблема

Сейчас browser_task ждёт WAIT_MS=12s и отдаёт «still running» — дальше человек
должен пинговать «ну что». Хотим: если джоб не завершился за эти 12s, агент
ставит wakeup kind="browser_poll" (+2 минуты), и фоновый ход сам доводит дело:
поллит, при завершении шлёт результат ПЕРВЫМ, при не-завершении — пере-ставит
wakeup (максимум ~20 минут суммарно, потом честно сдаётся одним сообщением).

## Изменения

### 1. agent/tools/browser_task.ts

После существующего `waitForRun(...)`: если статус НЕ терминальный
(используй/экспортируй isTerminal из agent/lib/browseruse.ts — сейчас он
приватный, сделай export), то:

```ts
await scheduleWakeup(phone, {
  at: Date.now() + 2 * 60_000,
  kind: "browser_poll",
  payload: task,
}).catch((err) => console.error("browser poll wakeup failed", err));
```

и добавь в возвращаемый payload hint-фразу, что Bro сам напишет, когда
закончит (агент не должен обещать «спроси позже»).

Дублей не плодить: scheduleWakeup для browser_poll должен заменять существующий
scheduled browser_poll этого тенанта (см. ниже §3).

### 2. Фоновый ход browser_poll — промпт в /internal/wakeup

В agent/channels/imessage.ts роут /internal/wakeup для kind==="browser_poll"
формирует промпт вида: `[background wakeup] Проверь статус текущего
браузер-джоба вызовом тула browser_task с task=<payload>. Если completed —
отправь человеку результаты. Если ещё работает — ответь [SILENT] (wakeup сам
повторится). Если failed — коротко скажи об этом.`
(Если в роуте уже есть генерация промпта per-kind — просто добавь ветку.)

Повтор: чтобы «wakeup сам повторится», browser_poll ставится с recurMinutes=2
при создании (тогда finish(ok:true) сам перепланирует). Но нужен СТОП:
когда агент в фоновом ходе получил терминальный статус и отправил результат,
poll больше не нужен. Сделай так: в agent/tools/browser_task.ts, когда статус
терминальный (в ЛЮБОМ вызове тула), после persist добавь
`await cancelWakeup(phone, { kind: "browser_poll" }).catch(() => {})`.
Это одна точка: и человеческий пинг, и фоновый ход гасят poll.

Лимит «сдаёмся»: attempts/giveUp уже есть в wakeups core? Они про ошибки
диспатча, не про долгий джоб. Для долгого джоба: при создании browser_poll
клади в payload JSON НЕ надо — оставь task строкой; вместо этого проверь в
tools/browser_task: если tenant.browserStatus не терминальный И
tenant.browserRunId тот же И прошло > 20 минут с момента старта — верни в
payload hint «джоб висит слишком долго, скажи человеку и предложи reset»,
и погаси poll-wakeup. Время старта: добавь поле browserStartedAt (number) в
tenants (schema + setBrowser в convex/tenants.ts + agent/lib/convex.ts patch
type), проставляй при startRun.

### 3. convex/wakeups.ts — дедуп для browser_poll

В `schedule`: расширь существующий дедуп brief: для kind "brief" И
"browser_poll" — если у тенанта уже есть scheduled такого kind, patch вместо
insert. (Один in-flight poll на человека, как и один браузер-джоб.)

### 4. scripts/browser-policy-check.ts — дополни

Добавь asserts на новое поведение чистых функций, если ты выносил решения в
чистые функции (например «pollTimedOut(startedAt, now)» в
agent/lib/browser-policy.ts — вынеси, 20 минут). Проверь: не истёк → false,
истёк → true, browserStartedAt undefined → false.

## Верификация

```bash
source ~/.nvm/nvm.sh && nvm use 24
npx eve build   # errors==0
npm run -s browser:check && npm run -s wakeups:check && npm run -s imessage:check && npm run -s access:check && npm run -s connect-link:check
```

НЕ запускай convex-команды. НЕ коммить. В конце — список файлов + результаты.
