(function () {
  var TOKEN = "bro.session";
  var KINDS = { login: 1, payment: 1, address: 1, contact: 1 };
  var IDENTS = { email: 1, phone: 1, username: 1 };
  var KIND_RU = {
    login: "вход",
    payment: "карта",
    address: "адрес",
    contact: "контакт",
  };

  function site() {
    var s = window.BRO_CONVEX_SITE_URL;
    return typeof s === "string" ? s.replace(/\/$/, "") : "";
  }

  function token() {
    return localStorage.getItem(TOKEN) || "";
  }

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  function isOrigin(value) {
    if (!value) return false;
    try {
      var u = new URL(value);
      return (u.protocol === "http:" || u.protocol === "https:") && u.origin === value;
    } catch (e) {
      return false;
    }
  }

  function parseKind(raw) {
    return raw && KINDS[raw] ? raw : "";
  }

  function parseIdent(raw) {
    return raw && IDENTS[raw] ? raw : "";
  }

  function parseLabel(raw) {
    if (typeof raw !== "string") return "";
    var t = raw.trim();
    if (!t || t.length > 120) return "";
    return t;
  }

  function parseOrigin(raw) {
    return typeof raw === "string" && isOrigin(raw.trim()) ? raw.trim() : "";
  }

  function digits(s) {
    return String(s || "").replace(/\D/g, "");
  }

  function optional(s) {
    var t = String(s || "").trim();
    return t ? t : undefined;
  }

  function headers(t) {
    return { Authorization: "Bearer " + t, "Content-Type": "application/json" };
  }

  function query() {
    var p = new URLSearchParams(location.search);
    var kind = parseKind(p.get("kind"));
    return {
      kind: kind,
      label: parseLabel(p.get("label")),
      identifierType: kind === "login" ? parseIdent(p.get("identifier_type")) : "",
      origin: kind === "login" ? parseOrigin(p.get("origin")) : "",
    };
  }

  function setError(text) {
    $("form-error").textContent = text || "";
  }

  function setFlash(text) {
    var el = $("flash");
    el.textContent = text || "";
    el.hidden = !text;
  }

  function showKind(kind) {
    ["login", "payment", "address", "contact"].forEach(function (k) {
      var box = $("fields-" + k);
      if (box) box.hidden = k !== kind;
    });
  }

  function showLoginAuth() {
    var mode = (document.querySelector('input[name="login-auth"]:checked') || {}).value;
    $("login-password-row").hidden = mode !== "password";
  }

  function defaultLabel(kind, origin) {
    if (kind === "login" && origin) {
      try {
        return new URL(origin).hostname;
      } catch (e) {
        return "вход";
      }
    }
    if (kind === "payment") return "Карта";
    if (kind === "address") return "Адрес";
    if (kind === "contact") return "Контакт";
    return "вход";
  }

  function applyPrefill(q) {
    var kind = q.kind || "login";
    $("kind").value = kind;
    showKind(kind);
    if (q.label) $("label").value = q.label;
    if (kind === "login") {
      if (q.identifierType) $("login-ident-type").value = q.identifierType;
      if (q.origin) {
        $("login-origin").value = q.origin;
        $("login-origin").readOnly = true;
      }
    }
  }

  function sessionGone(boot, body, msg) {
    localStorage.removeItem(TOKEN);
    body.hidden = true;
    boot.hidden = false;
    boot.textContent = msg;
    $("login-open").hidden = false;
    $("logout").hidden = true;
    $("cabinet-open").hidden = true;
  }

  function buildSecret(kind) {
    if (kind === "login") {
      var origin = ($("login-origin").value || "").trim();
      if (!isOrigin(origin)) {
        return { error: "Нужен адрес сайта вида https://www.wildberries.ru" };
      }
      var identType = $("login-ident-type").value;
      if (!IDENTS[identType]) return { error: "Выбери тип логина" };
      var ident = ($("login-ident").value || "").trim();
      if (!ident) return { error: "Нужен логин, почта или телефон" };
      if (ident.length > 300) return { error: "Слишком длинный логин" };
      var mode = (document.querySelector('input[name="login-auth"]:checked') || {}).value;
      var authentication;
      if (mode === "password") {
        var password = $("login-password").value || "";
        if (!password) return { error: "Нужен пароль" };
        if (password.length > 2000) return { error: "Слишком длинный пароль" };
        authentication = { type: "password", password: password };
      } else if (mode === "email_otp") {
        authentication = { type: "email_otp" };
      } else if (mode === "sms_otp") {
        authentication = { type: "sms_otp" };
      } else {
        return { error: "Выбери, как входить" };
      }
      return {
        secret: {
          kind: "login",
          version: 1,
          origin: origin,
          identifier: { type: identType, value: ident },
          authentication: authentication,
        },
      };
    }

    if (kind === "payment") {
      var cardholderName = ($("pay-name").value || "").trim();
      if (!cardholderName) return { error: "Нужно имя на карте" };
      if (cardholderName.length > 200) return { error: "Слишком длинное имя" };
      var number = digits($("pay-number").value);
      if (!/^\d{12,19}$/.test(number)) return { error: "Номер карты — 12–19 цифр" };
      var expirationMonth = Number(($("pay-month").value || "").trim());
      if (!Number.isInteger(expirationMonth) || expirationMonth < 1 || expirationMonth > 12) {
        return { error: "Месяц — от 1 до 12" };
      }
      var expirationYear = Number(($("pay-year").value || "").trim());
      if (!Number.isInteger(expirationYear) || expirationYear < 2000 || expirationYear > 9999) {
        return { error: "Год — четыре цифры, от 2000" };
      }
      var securityCode = digits($("pay-cvv").value);
      if (!/^\d{3,4}$/.test(securityCode)) return { error: "CVV — 3 или 4 цифры" };
      var billingPostalCode = optional($("pay-postal").value);
      if (billingPostalCode && billingPostalCode.length > 2000) {
        return { error: "Слишком длинный индекс" };
      }
      var card = {
        kind: "payment-card",
        version: 1,
        cardholderName: cardholderName,
        number: number,
        expirationMonth: expirationMonth,
        expirationYear: expirationYear,
        securityCode: securityCode,
      };
      if (billingPostalCode) card.billingPostalCode = billingPostalCode;
      return { secret: card };
    }

    if (kind === "address") {
      var recipientName = ($("addr-name").value || "").trim();
      var line1 = ($("addr-line1").value || "").trim();
      var city = ($("addr-city").value || "").trim();
      if (!recipientName) return { error: "Нужен получатель" };
      if (!line1) return { error: "Нужна улица" };
      if (!city) return { error: "Нужен город" };
      if (recipientName.length > 2000 || line1.length > 2000 || city.length > 2000) {
        return { error: "Слишком длинное поле" };
      }
      var line2 = optional($("addr-line2").value);
      var region = optional($("addr-region").value);
      var postalCode = optional($("addr-postal").value);
      if ((line2 && line2.length > 2000) || (region && region.length > 2000) || (postalCode && postalCode.length > 2000)) {
        return { error: "Слишком длинное поле" };
      }
      var countryRaw = ($("addr-country").value || "").trim();
      var countryCode = (countryRaw || "RU").toUpperCase();
      if (countryCode.length !== 2) return { error: "Страна — два символа, например RU" };
      var address = {
        kind: "address",
        version: 1,
        recipientName: recipientName,
        line1: line1,
        city: city,
        countryCode: countryCode,
      };
      if (line2) address.line2 = line2;
      if (region) address.region = region;
      if (postalCode) address.postalCode = postalCode;
      return { secret: address };
    }

    if (kind === "contact") {
      var fullName = optional($("contact-name").value);
      var email = optional($("contact-email").value);
      var phone = optional($("contact-phone").value);
      if (!fullName && !email && !phone) {
        return { error: "Нужны имя, почта или телефон" };
      }
      if ((fullName && fullName.length > 2000) || (email && email.length > 2000) || (phone && phone.length > 2000)) {
        return { error: "Слишком длинное поле" };
      }
      var contact = { kind: "contact", version: 1 };
      if (fullName) contact.fullName = fullName;
      if (email) contact.email = email;
      if (phone) contact.phone = phone;
      return { secret: contact };
    }

    return { error: "Неизвестный тип" };
  }

  function clearSecrets() {
    $("login-password").value = "";
    $("pay-number").value = "";
    $("pay-cvv").value = "";
    $("login-ident").value = "";
    $("pay-name").value = "";
    $("pay-month").value = "";
    $("pay-year").value = "";
    $("pay-postal").value = "";
    $("addr-name").value = "";
    $("addr-line1").value = "";
    $("addr-line2").value = "";
    $("addr-city").value = "";
    $("addr-region").value = "";
    $("addr-postal").value = "";
    $("contact-name").value = "";
    $("contact-email").value = "";
    $("contact-phone").value = "";
  }

  function renderItems(items) {
    var list = $("items");
    var empty = $("items-empty");
    list.innerHTML = "";
    if (!items || !items.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    items.forEach(function (item) {
      var kind = KIND_RU[item.kind] || item.kind;
      var siteLine = item.kind === "login" && item.origin ? esc(item.origin) : "";
      var li = document.createElement("li");
      li.innerHTML =
        '<div class="item-meta"><p class="item-label">' +
        esc(item.label || "") +
        '</p><p class="muted">' +
        esc(item.account || "") +
        "</p><p class=\"item-kind\">" +
        esc(kind) +
        (siteLine ? " · " + siteLine : "") +
        (item.available === false ? " · сейчас недоступно" : "") +
        "</p></div>" +
        '<button class="ghost item-del" type="button" data-handle="' +
        esc(item.handle || "") +
        '" data-step="ask">Удалить</button>';
      list.appendChild(li);
    });
  }

  function loadItems(base, t) {
    return fetch(base + "/vault/items", { headers: { Authorization: "Bearer " + t } })
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data };
        });
      })
      .then(function (got) {
        if (got.res.status === 401 || (got.data && got.data.ok === false && got.data.code === "unauthorized")) {
          return { expired: true };
        }
        if (!got.res.ok || !got.data || !got.data.ok) {
          $("items-empty").textContent = "Не вышло загрузить список.";
          $("items-empty").hidden = false;
          return {};
        }
        renderItems(got.data.items || []);
        return {};
      });
  }

  var boot = $("boot");
  var body = $("body");
  var q = query();
  var base = site();
  var t = token();

  applyPrefill(q);
  showLoginAuth();

  $("add-form").addEventListener("submit", function (e) {
    e.preventDefault();
  });
  $("kind").addEventListener("change", function () {
    showKind($("kind").value);
  });
  document.querySelectorAll('input[name="login-auth"]').forEach(function (el) {
    el.addEventListener("change", showLoginAuth);
  });

  if ($("logout")) {
    $("logout").addEventListener("click", function () {
      sessionGone(boot, body, "Войди, чтобы открыть сейф.");
    });
  }

  $("items").addEventListener("click", function (e) {
    var btn = e.target.closest(".item-del");
    if (!btn) return;
    var handle = btn.getAttribute("data-handle") || "";
    if (!handle) return;
    if (btn.getAttribute("data-step") !== "sure") {
      document.querySelectorAll(".item-del").forEach(function (other) {
        other.setAttribute("data-step", "ask");
        other.textContent = "Удалить";
      });
      btn.setAttribute("data-step", "sure");
      btn.textContent = "Точно удалить?";
      return;
    }
    var now = token();
    if (!base || !now) {
      sessionGone(boot, body, "Сессия истекла. Войди снова.");
      $("login-open").click();
      return;
    }
    btn.disabled = true;
    fetch(base + "/vault/items/delete", {
      method: "POST",
      headers: headers(now),
      body: JSON.stringify({ handle: handle }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data };
        });
      })
      .then(function (got) {
        if (got.res.status === 401) {
          sessionGone(boot, body, "Сессия истекла. Войди снова.");
          $("login-open").click();
          return;
        }
        return loadItems(base, now);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "Не вышло";
      });
  });

  $("save").addEventListener("click", function () {
    setError("");
    setFlash("");
    var kind = $("kind").value;
    if (!KINDS[kind]) {
      setError("Выбери тип");
      return;
    }
    var label = ($("label").value || "").trim() || defaultLabel(kind, $("login-origin").value);
    if (!label || label.length > 120) {
      setError("Нужна короткая метка");
      return;
    }
    var built = buildSecret(kind);
    if (built.error) {
      setError(built.error);
      return;
    }
    var now = token();
    if (!base || !now) {
      sessionGone(boot, body, "Сессия истекла. Войди снова.");
      $("login-open").click();
      return;
    }
    var payload = JSON.stringify({
      kind: kind,
      label: label,
      secret: JSON.stringify(built.secret),
    });
    $("save").disabled = true;
    fetch(base + "/vault/items", {
      method: "POST",
      headers: headers(now),
      body: payload,
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data };
        });
      })
      .then(function (got) {
        $("save").disabled = false;
        if (got.res.status === 401) {
          sessionGone(boot, body, "Сессия истекла. Войди снова.");
          $("login-open").click();
          return;
        }
        if (got.res.status === 400 || (got.data && got.data.code === "invalid")) {
          setError("Проверь поля");
          return;
        }
        if (!got.res.ok || !got.data || !got.data.ok) {
          setError("Не вышло сохранить");
          return;
        }
        clearSecrets();
        setFlash("Готово. Вернись в iMessage и напиши Bro.");
        return loadItems(base, now);
      })
      .catch(function () {
        $("save").disabled = false;
        setError("Не вышло, нажми ещё раз");
      });
  });

  if (!t) {
    boot.textContent = "Войди, чтобы открыть сейф.";
    $("login-open").click();
    return;
  }
  if (!base) {
    boot.textContent = "Сайт ещё не подключён";
    return;
  }

  fetch(base + "/me", { headers: { Authorization: "Bearer " + t } })
    .then(function (res) {
      return res.json().then(function (data) {
        return { res: res, data: data };
      });
    })
    .then(function (got) {
      if (!got.res.ok || !got.data.ok) {
        sessionGone(boot, body, "Сессия истекла. Войди снова.");
        return;
      }
      boot.hidden = true;
      body.hidden = false;
      return loadItems(base, t).then(function (result) {
        if (result && result.expired) {
          sessionGone(boot, body, "Сессия истекла. Войди снова.");
        }
      });
    })
    .catch(function () {
      boot.textContent = "Не вышло загрузить сейф";
    });
})();
