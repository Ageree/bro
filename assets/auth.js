(function () {
  var HANDLE = "bro.handle";
  var TOKEN = "bro.session";

  function site() {
    var s = window.BRO_CONVEX_SITE_URL;
    return typeof s === "string" ? s.replace(/\/$/, "") : "";
  }

  window.broIMessageLink = function () {
    var s = window.BRO_IMESSAGE_LINK;
    return typeof s === "string" ? s : "";
  };

  window.broIsIos = function () {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  };

  function handle() {
    return localStorage.getItem(HANDLE) || "";
  }

  function token() {
    return localStorage.getItem(TOKEN) || "";
  }

  function setHandle(h) {
    if (h) localStorage.setItem(HANDLE, h);
  }

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

  function validHandle(h) {
    return /^bro-[a-z0-9]{8}$/.test(h);
  }

  function storedHandle() {
    var h = (handle() || "").trim();
    return validHandle(h) ? h : "";
  }

  var MISSING_HANDLE =
    "Введи handle вида bro-xxxxxxxx — или открой сайт на том же iPhone и нажми «Запросить доступ».";

  function typedHandle() {
    var input = $("#login-handle");
    var raw = input ? (input.value || "").trim().toLowerCase() : "";
    return validHandle(raw) ? raw : "";
  }

  function loginHandle() {
    return storedHandle() || typedHandle();
  }

  function paintHandleRow() {
    var row = $("#login-handle-row");
    var input = $("#login-handle");
    var sendBtn = $("#login-send");
    var h = storedHandle();
    if (row) row.hidden = false;
    if (input && !input.value) input.value = h;
    if (sendBtn) sendBtn.hidden = false;
    return loginHandle();
  }

  function openModal() {
    modal.hidden = false;
    var h = paintHandleRow();
    $("#login-status").textContent = h ? "" : MISSING_HANDLE;
    $("#login-code-row").hidden = true;
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

  $("#login-send").addEventListener("click", function () {
    var base = site();
    var h = loginHandle();
    if (!base) {
      setStatus("Сайт ещё не подключён");
      return;
    }
    if (!h) {
      setStatus(MISSING_HANDLE);
      return;
    }
    setHandle(h);
    setStatus("Шлём код в iMessage…");
    fetch(base + "/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: h }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (data.code === "unavailable" || data.code === "unbound" || data.code === "unknown") {
            setStatus("Сначала напиши Bro в iMessage");
          } else if (data.code === "cooldown") setStatus("Подожди минуту и нажми ещё раз");
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
    var h = loginHandle();
    var code = ($("#login-code").value || "").trim();
    if (!h) {
      setStatus(MISSING_HANDLE);
      return;
    }
    setStatus("Проверяем…");
    fetch(base + "/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: h, code: code }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (data.code === "wrong") setStatus("Неверный код");
          else if (data.code === "expired" || data.code === "locked") {
            setStatus("Код больше не действует, запроси новый");
          } else setStatus("Не вышло, нажми ещё раз");
          return;
        }
        setHandle(data.handle || h);
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
})();
