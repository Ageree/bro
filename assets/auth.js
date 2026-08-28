(function () {
  var HANDLE = "bro.handle";
  var TOKEN = "bro.session";

  function site() {
    var s = window.BRO_CONVEX_SITE_URL;
    return typeof s === "string" ? s.replace(/\/$/, "") : "";
  }

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

  var loginBtn = $(".login-open");
  var cabinetBtn = $(".cabinet-open");
  var logoutBtn = $(".logout");
  var modal = $(".login-modal");
  if (!loginBtn || !modal) return;

  function painted() {
    var in_ = Boolean(token());
    loginBtn.hidden = in_;
    if (cabinetBtn) cabinetBtn.hidden = !in_;
    if (logoutBtn) logoutBtn.hidden = !in_;
  }

  function openModal() {
    modal.hidden = false;
    var input = $("#login-handle");
    if (input && !input.value) input.value = handle();
    $("#login-status").textContent = "";
    $("#login-code-row").hidden = true;
  }

  function closeModal() {
    modal.hidden = true;
  }

  function setStatus(t) {
    $("#login-status").textContent = t;
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
    var h = ($("#login-handle").value || "").trim();
    if (!base) {
      setStatus("Сайт ещё не подключён");
      return;
    }
    if (!/^bro-[a-z0-9]{8}$/.test(h)) {
      setStatus("Нужен handle вида bro-xxxxxxxx");
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
    var h = ($("#login-handle").value || "").trim();
    var code = ($("#login-code").value || "").trim();
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
        window.location.href = "/cabinet.html";
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
