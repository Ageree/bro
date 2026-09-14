(function () {
  var HANDLE = "bro.handle";
  var PHONE = "bro.phone";
  var TOKEN = "bro.session";

  function site() {
    var s = window.BRO_CONVEX_SITE_URL;
    return typeof s === "string" ? s.replace(/\/$/, "") : "";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  function validHandle(h) {
    return /^bro-[a-z0-9]{8}$/.test(h || "");
  }

  function queryHandle() {
    try {
      var q = new URLSearchParams(location.search).get("handle");
      return validHandle(q) ? q : "";
    } catch (e) {
      return "";
    }
  }

  function storedHandle() {
    var h = (localStorage.getItem(HANDLE) || "").trim();
    return validHandle(h) ? h : "";
  }

  function storedPhone() {
    return (localStorage.getItem(PHONE) || "").trim();
  }

  window.bro = { site: site, token: token, esc: esc };

  window.broIMessageLink = function () {
    var s = window.BRO_IMESSAGE_LINK;
    return typeof s === "string" ? s : "";
  };

  window.broIsIos = function () {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  };

  function token() {
    return localStorage.getItem(TOKEN) || "";
  }

  function setHandle(h) {
    if (h && validHandle(h)) localStorage.setItem(HANDLE, h);
  }

  function setPhone(p) {
    if (p) localStorage.setItem(PHONE, p);
  }

  var fromUrl = queryHandle();
  if (fromUrl) setHandle(fromUrl);

  function setToken(t) {
    if (t) localStorage.setItem(TOKEN, t);
    else localStorage.removeItem(TOKEN);
  }

  window.broStoreSession = function (h, t) {
    setHandle(h);
    if (t) setToken(t);
  };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  var loginBtn = $("#login-open");
  var cabinetBtn = $("#cabinet-open");
  var vaultBtn = $("#vault-open");
  var logoutBtn = $("#logout");
  var modal = $("#login-modal");
  if (!loginBtn || !modal) return;

  function painted() {
    var in_ = Boolean(token());
    loginBtn.hidden = in_;
    if (cabinetBtn) cabinetBtn.hidden = !in_;
    if (vaultBtn) vaultBtn.hidden = !in_;
    if (logoutBtn) logoutBtn.hidden = !in_;
  }

  var PHONE_HINT = "Введи телефон, с которого пишешь Bro. Код придёт в iMessage.";
  var CODE_HINT = "Код придёт в iMessage.";
  var NEED_PHONE = "Нужен телефон, с которого пишешь Bro.";
  var WRITE_FIRST = "Сначала напиши Bro в iMessage.";

  function fieldPhone() {
    var el = $("#login-phone");
    return el ? (el.value || "").trim() : "";
  }

  function fallbackHandle() {
    return fromUrl || "";
  }

  function paintLogin() {
    var handleOnly = Boolean(fallbackHandle()) && !fieldPhone() && !storedPhone();
    var phoneRow = $("#login-phone-row");
    var writeBtn = $("#login-write-bro");
    var hint = $("#login-hint");
    var sendBtn = $("#login-send");
    var phoneEl = $("#login-phone");
    if (phoneEl && storedPhone() && !phoneEl.value) phoneEl.value = storedPhone();
    if (phoneRow) phoneRow.hidden = handleOnly;
    if (writeBtn) writeBtn.hidden = handleOnly;
    if (hint) hint.textContent = handleOnly ? CODE_HINT : PHONE_HINT;
    if (sendBtn) sendBtn.textContent = "Получить код";
    return handleOnly;
  }

  function openModal() {
    modal.hidden = false;
    $("#login-status").textContent = "";
    $("#login-code-row").hidden = true;
    paintLogin();
    var phoneEl = $("#login-phone");
    if (phoneEl && !phoneEl.hidden && !$("#login-phone-row").hidden) phoneEl.focus();
  }

  function closeModal() {
    modal.hidden = true;
  }

  function setStatus(t) {
    $("#login-status").textContent = t;
  }

  // A vault link from Bro carries the item to add in its query, so logging in
  // must return to this exact page instead of dropping the person in cabinet.
  function afterLogin() {
    if (/\/vault\.html$/.test(location.pathname)) {
      return location.pathname + location.search;
    }
    return "/cabinet.html";
  }

  function writeBro() {
    var link = window.broIMessageLink ? window.broIMessageLink() : "";
    if (window.broIsIos && window.broIsIos() && link) {
      window.location.href = link;
      return;
    }
    setStatus("Открой на iPhone");
  }

  loginBtn.addEventListener("click", function (e) {
    e.preventDefault();
    openModal();
  });
  $("#login-cancel").addEventListener("click", function (e) {
    e.preventDefault();
    closeModal();
  });
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });
  var writeBtn = $("#login-write-bro");
  if (writeBtn) {
    writeBtn.addEventListener("click", function (e) {
      e.preventDefault();
      writeBro();
    });
  }

  var loginPhoneField = $("#login-phone");
  if (loginPhoneField) {
    loginPhoneField.addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("#login-send").click();
    });
  }
  var loginCodeField = $("#login-code");
  if (loginCodeField) {
    loginCodeField.addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("#login-verify").click();
    });
  }

  function startBody() {
    var phone = fieldPhone() || storedPhone();
    if (phone) return { phone: phone, stored: phone };
    var h = fallbackHandle();
    if (h) return { handle: h };
    return null;
  }

  $("#login-send").addEventListener("click", function () {
    var base = site();
    var body = startBody();
    if (!body) {
      setStatus(NEED_PHONE);
      return;
    }
    if (!base) {
      setStatus("Сайт ещё не подключён");
      return;
    }
    if (body.stored) setPhone(body.stored);
    setStatus("Шлём код в iMessage…");
    var payload = body.phone ? { phone: body.phone } : { handle: body.handle };
    fetch(base + "/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (data.code === "unavailable" || data.code === "unbound" || data.code === "unknown") {
            setStatus(WRITE_FIRST);
          } else if (data.code === "cooldown") setStatus("Подожди минуту и нажми ещё раз");
          else if (data.code === "error") setStatus("Не получилось отправить код, попробуй ещё раз");
          else setStatus("Не вышло, нажми ещё раз");
          return;
        }
        $("#login-code-row").hidden = false;
        setStatus("Код пришёл в iMessage");
        $("#login-code").focus();
      })
      .catch(function () {
        setStatus("Не вышло, нажми ещё раз");
      });
  });

  $("#login-verify").addEventListener("click", function () {
    var base = site();
    var body = startBody();
    var code = ($("#login-code").value || "").replace(/\D/g, "");
    if (!body) {
      setStatus(NEED_PHONE);
      return;
    }
    if (code.length !== 6) {
      setStatus("Код — 6 цифр");
      return;
    }
    setStatus("Проверяем…");
    var payload = body.phone
      ? { phone: body.phone, code: code }
      : { handle: body.handle, code: code };
    fetch(base + "/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (data.code === "wrong") setStatus("Неверный код");
          else if (data.code === "unknown") setStatus("Код — 6 цифр");
          else if (data.code === "expired") setStatus("Код устарел, запроси новый");
          else if (data.code === "locked") {
            setStatus("Код больше не действует, запроси новый");
          } else setStatus("Не вышло, нажми ещё раз");
          return;
        }
        if (body.phone) setPhone(body.phone);
        if (data.handle) setHandle(data.handle);
        setToken(data.token);
        closeModal();
        window.location.href = afterLogin();
      })
      .catch(function () {
        setStatus("Не вышло, нажми ещё раз");
      });
  });

  if (logoutBtn) {
    logoutBtn.addEventListener("click", function (e) {
      e.preventDefault();
      var base = site();
      var t = token();
      setToken("");
      if (base && t) {
        fetch(base + "/logout", {
          method: "POST",
          headers: { Authorization: "Bearer " + t },
        }).catch(function () {});
      }
      painted();
      if (/cabinet\.html$/.test(location.pathname)) location.href = "/";
    });
  }

  painted();
  // Old Bro links still carry ?handle=. Open the same sheet on «Получить код».
  if (fromUrl && !token()) openModal();
})();
