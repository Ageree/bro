---
name: otp
description: When a worker or browser job needs a one-time code, look in Bro's mailbox and the archive before asking in the iMessage thread.
---

# OTP orchestration

Код из банка / WB / клиники часто падает на ящик Bro, не в чат.

1. `worker` вернул `Needs user input:` про код — не спрашивай человека сразу.
2. Сначала `otp` (субагент) или `otp_lookup`. Можно сам: `bro_mail` action=inbox, потом `archive__search`.
3. `found` — сразу продолжи того же worker (`agentId` + код). В чат цифры не цитируй. Коротко: «код из почты, ввожу».
4. `missing` / `ambiguous` — один вопрос в треде. Если код должен прийти на ящик Bro: `job_wait` waitingFor=email, checkInMinutes=3.
5. Входящее `[event:mail]` во время ожидания кода — письмо Bro, не человек. Извлеки код, продолжи worker, не пересылай письмо целиком.
6. 3-D Secure / банк-приложение / push — по-прежнему liveUrl, не этот путь.
