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

  var loginBtn = $("#login-open");
  var cabinetBtn = $("#cabinet-open");
  var logoutBtn = $("#logout");
  var modal = $("#login-modal");
  if (!loginBtn || !modal) return;

  var sending = false;
  var verifying = false;
  var autoMode = false;
  var currentLogin = "";
  // True while a #login=… magic link is being verified: cabinet/vault pages
  // auto-open the modal when there is no token yet, and that must not race
  // the redirect (or burn the cooldown with a second /login/start).
  var magicPending = false;

  function painted() {
    var in_ = Boolean(token());
    loginBtn.hidden = in_;
    if (cabinetBtn) cabinetBtn.hidden = !in_;
    if (logoutBtn) logoutBtn.hidden = !in_;
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

  function isValidLogin(v) {
    if (/^bro-[a-z0-9]{8}$/i.test(v)) return true;
    var digits = (v.match(/\d/g) || []).length;
    return digits >= 10;
  }

  function setAutoMode(v) {
    autoMode = v;
    $("#login-phone-row").hidden = v;
    $("#login-other").hidden = !v;
  }

  function resetModal() {
    modal.hidden = false;
    setStatus("");
    var codeInput = $("#login-code");
    codeInput.value = "";
    $("#login-code-row").hidden = true;
    $("#login-resend").hidden = true;
  }

  function closeModal() {
    modal.hidden = true;
  }

  function revealCode(text) {
    $("#login-code-row").hidden = false;
    $("#login-resend").hidden = false;
    setStatus(text);
    var codeInput = $("#login-code");
    codeInput.value = "";
    codeInput.focus();
  }

  function currentInputLogin() {
    if (autoMode) return currentLogin;
    return ($("#login-handle").value || "").trim();
  }

  function startLogin(login, opts) {
    opts = opts || {};
    if (sending) return;
    var base = site();
    if (!base) {
      setStatus("Сайт ещё не подключён");
      return;
    }
    if (!login) return;
    sending = true;
    var btn = $("#login-send");
    btn.setAttribute("aria-busy", "true");
    if (!opts.auto) setStatus("Отправляем код…");
    fetch(base + "/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: login }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        sending = false;
        btn.removeAttribute("aria-busy");
        if (!data.ok) {
          if (data.code === "unknown" || data.code === "unbound") {
            if (opts.auto) {
              setAutoMode(false);
              setStatus("");
            } else {
              setStatus("Сначала напиши Bro в iMessage");
            }
            return;
          }
          if (data.code === "cooldown") {
            currentLogin = login;
            revealCode("Код уже отправлен — посмотри iMessage");
            return;
          }
          setStatus("Не вышло, попробуй ещё раз");
          return;
        }
        currentLogin = login;
        revealCode("Код отправлен в iMessage");
      })
      .catch(function () {
        sending = false;
        btn.removeAttribute("aria-busy");
        setStatus("Не вышло, попробуй ещё раз");
      });
  }

  function doSend() {
    var raw = currentInputLogin();
    if (!autoMode && !isValidLogin(raw)) {
      setStatus("Введи номер телефона, с которого пишешь Bro");
      return;
    }
    startLogin(raw, { auto: autoMode });
  }

  function doVerify() {
    if (verifying) return;
    var code = ($("#login-code").value || "").replace(/\D/g, "");
    if (code.length !== 6) return;
    var login = currentLogin || currentInputLogin();
    if (!login) {
      setStatus("Введи номер телефона, с которого пишешь Bro");
      return;
    }
    var base = site();
    if (!base) {
      setStatus("Сайт ещё не подключён");
      return;
    }
    verifying = true;
    var btn = $("#login-verify");
    btn.setAttribute("aria-busy", "true");
    setStatus("Проверяем…");
    fetch(base + "/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: login, code: code }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        verifying = false;
        btn.removeAttribute("aria-busy");
        if (!data.ok) {
          if (data.code === "wrong") setStatus("Неверный код, попробуй ещё раз");
          else if (data.code === "expired" || data.code === "locked") {
            setStatus("Код устарел — нажми «Отправить код ещё раз»");
          } else setStatus("Не вышло, попробуй ещё раз");
          return;
        }
        setHandle(data.handle || login);
        setToken(data.token);
        closeModal();
        window.location.href = afterLogin();
      })
      .catch(function () {
        verifying = false;
        btn.removeAttribute("aria-busy");
        setStatus("Не вышло, попробуй ещё раз");
      });
  }

  loginBtn.addEventListener("click", function (e) {
    e.preventDefault();
    if (magicPending) return;
    resetModal();
    var stored = handle();
    if (stored) {
      setAutoMode(true);
      currentLogin = stored;
      startLogin(stored, { auto: true });
    } else {
      setAutoMode(false);
      currentLogin = "";
      $("#login-handle").value = "";
      $("#login-handle").focus();
    }
  });

  $("#login-cancel").addEventListener("click", function (e) {
    e.preventDefault();
    closeModal();
  });
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });

  $("#login-send").addEventListener("click", function (e) {
    e.preventDefault();
    doSend();
  });

  $("#login-handle").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doSend();
    }
  });

  $("#login-resend").addEventListener("click", function (e) {
    e.preventDefault();
    doSend();
  });

  $("#login-other").addEventListener("click", function (e) {
    e.preventDefault();
    if (sending) return;
    setAutoMode(false);
    currentLogin = "";
    $("#login-code-row").hidden = true;
    $("#login-resend").hidden = true;
    $("#login-handle").value = "";
    setStatus("");
    $("#login-handle").focus();
  });

  $("#login-code").addEventListener("input", function (e) {
    var v = e.target.value.replace(/\D/g, "").slice(0, 6);
    e.target.value = v;
    if (v.length === 6) doVerify();
  });

  $("#login-code").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doVerify();
    }
  });

  $("#login-verify").addEventListener("click", function (e) {
    e.preventDefault();
    doVerify();
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

  // A tap on the iMessage magic link lands here as #login=<handle>.<code>;
  // verify it right away, before painted() decides which header buttons show.
  var magicMatch = /^#login=(.+)\.(\d{6})$/.exec(location.hash);
  if (magicMatch) {
    var mLogin = decodeURIComponent(magicMatch[1]);
    var mCode = magicMatch[2];
    var base = site();
    if (base) {
      magicPending = true;
      fetch(base + "/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: mLogin, code: mCode }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          history.replaceState(null, "", location.pathname + location.search);
          magicPending = false;
          if (data.ok) {
            setHandle(data.handle || mLogin);
            setToken(data.token);
            location.replace(afterLogin());
          } else {
            resetModal();
            setAutoMode(false);
            currentLogin = "";
            setStatus("Ссылка устарела, запроси код ещё раз");
            painted();
          }
        })
        .catch(function () {
          history.replaceState(null, "", location.pathname + location.search);
          magicPending = false;
          resetModal();
          setAutoMode(false);
          currentLogin = "";
          setStatus("Ссылка устарела, запроси код ещё раз");
          painted();
        });
    } else {
      history.replaceState(null, "", location.pathname + location.search);
      resetModal();
      setStatus("Сайт ещё не подключён");
      painted();
    }
  } else {
    painted();
  }
})();
