"""A local copy of PREDUBEZHDAI's checkout (RU 04.10), for the browser checkout harness (checkout_harness.py).

The shop runs on 127.0.0.1 (SHOP_PORT) and its payment processor, like ЮKassa, on another origin, localhost
(PAY_PORT), so the card form sits in a cross-origin frame. It reproduces what broke the errands of 04.10:

- the header's profile icon opens a sign-in modal (email and password); an email that has an account cannot
  check out as a guest: 409 «User already exist», shown as «На ваш email был создан личный кабинет. Пароль
  выслан на почту.»;
- the phone field behaves like react-phone-number-input with a fixed «+7»: the prefix cannot be deleted, so
  typing «+7 921…» into it makes «+7 7921…» and flips the country to Kazakhstan; only the ten digits after
  +7 make a valid number, and the server checks it;
- the city field suggests cities a second after the last keystroke, and typing into it again drops the city,
  the delivery and the store already chosen;
- «Самовывоз» sets a valid delivery method only once a store is chosen;
- «К ОПЛАТЕ» opens the payment step (СБП by default, «Карта»), «ОПЛАТИТЬ» creates the order and opens the
  payment page with the card form in the processor's frame (number, ММ and ГГ boxes, CVC);
- a legacy /order page whose form always fails with 400 (deliveryMethod, countryCode), for a run that goes
  there from memory; a refused order leaves the checkout for /order/error with no reason shown.

Every request is recorded (`Shop.log`) so the harness can say what the run did. State is in memory; one
`Shop` serves one scenario.
"""

import itertools
import json
import re
import secrets
import time

from aiohttp import web

SHOP_PORT = 8711
PAY_PORT = 8712
SHOP = f"http://127.0.0.1:{SHOP_PORT}"
PAY = f"http://localhost:{PAY_PORT}"

# The person of the errand, as Bro's facts name them, and their account on the shop.
EMAIL = "savely@example.com"
PASSWORD = "-".join(["fixture", "only", "0410"])
PHONE = "+79217818876"
# The test card of browser-vm/worker/test_card_forms.py.
CARD = {"number": "4276550101324310", "month": "01", "year": "31", "cvc": "249", "holder": "SAVELY SOLOVYEV"}

PRODUCTS = {
    "vam-i-ne-snilos-30": {"name": "Крем для рук VAM I NE SNILOS, 30 мл", "price": 2100,
                           "text": "Крем для рук с ароматом инжира и кедра. Объём 30 мл."},
    "vam-i-ne-snilos-75": {"name": "Крем для рук VAM I NE SNILOS, 75 мл", "price": 3900,
                           "text": "Крем для рук с ароматом инжира и кедра. Объём 75 мл."},
    "no-1-50": {"name": "Парфюмерная вода PREDUBEZHDAI No.1, 50 мл", "price": 8900,
                "text": "Древесный аромат. Объём 50 мл."},
}
CITIES = ["Москва", "Московский", "Мосальск", "Санкт-Петербург", "Казань", "Екатеринбург", "Новосибирск",
          "Нижний Новгород"]
STORES = {
    "Москва": [{"id": "chistoprudny", "name": "PREDUBEZHDAI Чистые пруды", "address": "Чистопрудный бульвар, 21"},
               {"id": "petrovka", "name": "PREDUBEZHDAI Петровка", "address": "ул. Петровка, 10"}],
    "Санкт-Петербург": [{"id": "nevsky", "name": "PREDUBEZHDAI Невский", "address": "Невский проспект, 48"}],
}
COURIER_FEE = 350
FIRST_ORDER = 43846

STYLE = """
<style>
body{font-family:Arial,sans-serif;margin:0;color:#111;background:#fff}
header{display:flex;align-items:center;gap:24px;padding:16px 32px;border-bottom:1px solid #ddd}
header .logo{font-weight:bold;letter-spacing:4px;font-size:20px;color:#111;text-decoration:none}
header nav{flex:1;display:flex;gap:16px}
header nav a{color:#111;text-decoration:none}
.icon{background:none;border:0;cursor:pointer;width:32px;height:32px;padding:0}
main{padding:24px 32px;max-width:960px}
.cards{display:flex;gap:16px}
.card{border:1px solid #ddd;padding:16px;width:260px}
.btn{background:#111;color:#fff;border:0;padding:12px 24px;cursor:pointer;text-transform:uppercase;letter-spacing:1px}
.btn.light{background:#fff;color:#111;border:1px solid #111}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center}
.modal.open{display:flex}
.modal .box{background:#fff;padding:32px;width:380px}
.modal input{display:block;width:100%;margin:8px 0;padding:8px;box-sizing:border-box}
.error{color:#c00}
.field{margin:10px 0}
.field input,.field select{padding:8px;width:320px}
.PhoneInput{display:flex;align-items:center;gap:6px;position:relative;width:340px}
.PhoneInputCountry{position:relative;display:flex;align-items:center;width:44px}
.PhoneInputCountrySelect{position:absolute;inset:0;opacity:0;cursor:pointer;width:44px}
.suggest{list-style:none;margin:0;padding:0;border:1px solid #ccc;width:336px;background:#fff}
.suggest li{padding:6px 8px;cursor:pointer}
.suggest li:hover{background:#eee}
.store{border:1px solid #ccc;padding:8px;margin:6px 0;width:420px}
.store.chosen{border-color:#111;background:#f4f4f4}
.hidden{display:none}
.toast{border:1px solid #111;padding:8px;margin-top:12px}
</style>
"""

PROFILE_ICON = ('<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" '
                'stroke="#111"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6" fill="none" stroke="#111"/></svg>')
CART_ICON = ('<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 7h14l-1 13H6z" fill="none" '
             'stroke="#111"/><path d="M9 7a3 3 0 0 1 6 0" fill="none" stroke="#111"/></svg>')

# The header of every page: the profile icon opens the sign-in modal for a guest and the account for a person
# signed in, as on the real site, where it carries no text of its own.
HEADER = """
<header>
  <a class="logo" href="/">PREDUBEZHDAI</a>
  <nav><a href="/">Каталог</a><a href="/#about">О бренде</a><a href="/#stores">Магазины</a></nav>
  <button class="icon" id="profile" aria-label="Профиль">""" + PROFILE_ICON + """</button>
  <a class="icon" href="/cart" aria-label="Корзина">""" + CART_ICON + """</a><span id="cart-count"></span>
</header>
<div class="modal" id="signin" role="dialog" aria-label="Вход">
  <div class="box">
    <h3>Вход в личный кабинет</h3>
    <input id="signin-email" type="email" placeholder="Email" autocomplete="username">
    <input id="signin-password" type="password" placeholder="Пароль" autocomplete="current-password">
    <label><input id="signin-remember" type="checkbox" style="width:auto;display:inline"> Запомнить меня</label>
    <p class="error" id="signin-error"></p>
    <button class="btn" id="signin-submit">Войти</button>
    <button class="btn light" id="signin-close">Закрыть</button>
    <p><a href="#">Забыли пароль?</a></p>
  </div>
</div>
<script>
async function api(method, path, body) {
  const response = await fetch(path, {method, headers: {'Content-Type': 'application/json'},
                                       body: body === undefined ? undefined : JSON.stringify(body)});
  let data = null;
  try { data = await response.json(); } catch (e) {}
  return {status: response.status, ok: response.ok, data};
}
const me = api('GET', '/api/me').then((r) => r.data);
me.then((m) => { document.getElementById('cart-count').textContent = m.cartCount ? '(' + m.cartCount + ')' : ''; });
document.getElementById('profile').onclick = async () => {
  const m = await me;
  if (m.user) { location.href = '/account'; return; }
  document.getElementById('signin').classList.add('open');
};
document.getElementById('signin-close').onclick = () => document.getElementById('signin').classList.remove('open');
document.getElementById('signin-submit').onclick = async () => {
  const r = await api('POST', '/api/auth/login', {email: document.getElementById('signin-email').value,
    password: document.getElementById('signin-password').value,
    remember: document.getElementById('signin-remember').checked});
  if (r.ok) { location.reload(); return; }
  document.getElementById('signin-error').textContent = (r.data && r.data.message) || 'Ошибка входа';
};
</script>
"""


def page(title, body):
    return web.Response(text=f"<!doctype html><html lang=ru><head><meta charset=utf-8><title>{title}</title>"
                             f"{STYLE}</head><body>{HEADER}<main>{body}</main></body></html>",
                        content_type="text/html")


def rub(amount):
    return f"{amount:,}".replace(",", " ") + " ₽"


HOME = """
<h1>Каталог</h1>
<div class="cards">
""" + "".join(f"""<div class="card"><a href="/product/{slug}">{p['name']}</a><p>{rub(p['price'])}</p></div>"""
               for slug, p in PRODUCTS.items()) + """
</div>
<h2 id="stores">Магазины</h2>
<p>Москва: Чистопрудный бульвар, 21; ул. Петровка, 10. Санкт-Петербург: Невский проспект, 48.</p>
"""

PRODUCT = """
<h1>{name}</h1>
<p>{text}</p>
<p><b>{price}</b></p>
<button class="btn" id="add">В корзину</button>
<div id="added" class="toast hidden">Товар добавлен в корзину. <a href="/cart">Перейти в корзину</a></div>
<script>
document.getElementById('add').onclick = async () => {{
  const r = await api('POST', '/api/cart', {{slug: '{slug}', qty: 1}});
  if (r.ok) {{
    document.getElementById('add').textContent = 'В корзине';
    document.getElementById('added').classList.remove('hidden');
    document.getElementById('cart-count').textContent = '(' + r.data.count + ')';
  }}
}};
</script>
"""

CART = """
<h1>Корзина</h1>
<div id="lines">Загрузка…</div>
<script>
async function draw() {
  const r = await api('GET', '/api/cart');
  const lines = document.getElementById('lines');
  if (!r.data.items.length) { lines.innerHTML = '<p>Корзина пуста. <a href="/">Перейти в каталог</a></p>'; return; }
  lines.innerHTML = r.data.items.map((i) => `<div class="store"><b>${i.name}</b> — ${i.qty} шт — ${i.sum}
    <button class="btn light" data-slug="${i.slug}">Удалить</button></div>`).join('') +
    `<p>Итого: <b>${r.data.totalText}</b></p><button class="btn" id="checkout">Оформить заказ</button>`;
  lines.querySelectorAll('[data-slug]').forEach((b) => b.onclick = async () => {
    await api('DELETE', '/api/cart/' + b.dataset.slug); draw(); });
  document.getElementById('checkout').onclick = () => { location.href = '/checkout'; };
}
draw();
</script>
"""

# The checkout is drawn by its script once the cart and the account load, as the real site's React form is.
CHECKOUT = """
<h1>Оформление заказа</h1>
<div id="app">Загрузка…</div>
<script>
const app = document.getElementById('app');
const state = {city: null, delivery: null, store: null, country: 'RU', national: '', payment: 'sbp', stores: []};
const flags = {RU: '🇷🇺', KZ: '🇰🇿', BY: '🇧🇾'};
function formatPhone(n) {
  if (!n) return '+7 ';
  if (n.startsWith('7')) return '+7 ' + n;  // a Kazakh number: libphonenumber groups it otherwise
  let s = '+7 ' + n.slice(0, 3);
  if (n.length > 3) s += ' ' + n.slice(3, 6);
  if (n.length > 6) s += '-' + n.slice(6, 8);
  if (n.length > 8) s += '-' + n.slice(8, 10);
  return s + n.slice(10);
}
async function start() {
  const [m, cart] = await Promise.all([me, api('GET', '/api/cart').then((r) => r.data)]);
  if (!cart.items.length) { app.innerHTML = '<p>Корзина пуста. <a href="/">Перейти в каталог</a></p>'; return; }
  const profile = m.profile || {};
  app.innerHTML = `
  <h2>Контактные данные</h2>
  <div class="field"><input name="firstName" placeholder="Имя" value="${profile.firstName || ''}"></div>
  <div class="field"><input name="lastName" placeholder="Фамилия" value="${profile.lastName || ''}"></div>
  <div class="field"><input name="email" type="email" placeholder="Email" value="${m.user || ''}"></div>
  <div class="field PhoneInput">
    <div class="PhoneInputCountry">
      <select class="PhoneInputCountrySelect" name="phoneCountry" aria-label="Phone number country">
        <option value="RU">Россия</option><option value="KZ">Казахстан</option><option value="BY">Беларусь</option>
      </select>
      <div class="PhoneInputCountryIcon" id="flag">${flags.RU}</div>
    </div>
    <input class="PhoneInputInput" type="tel" name="phone" autocomplete="tel" placeholder="Телефон">
  </div>
  <h2>Доставка</h2>
  <div class="field"><input name="city" placeholder="Введите город" autocomplete="off"><ul class="suggest hidden" id="suggest"></ul></div>
  <p class="error" id="city-error"></p>
  <div id="methods" class="hidden">
    <label><input type="radio" name="delivery" value="courier"> Курьером — 350 ₽, 1–2 дня</label><br>
    <label><input type="radio" name="delivery" value="pickup"> Самовывоз из магазина — бесплатно</label>
    <div id="address" class="field hidden"><input name="address" placeholder="Улица, дом, квартира"></div>
    <div id="stores" class="hidden"></div>
  </div>
  <h2>Ваш заказ</h2>
  ${cart.items.map((i) => `<p>${i.name} — ${i.qty} шт — ${i.sum}</p>`).join('')}
  <p>Доставка: <span id="fee">—</span></p>
  <p>Итого: <b id="total">${cart.totalText}</b></p>
  <button class="btn" id="to-pay">К оплате</button>
  <p class="error" id="form-error"></p>
  <div id="payment" class="hidden">
    <h2>Способ оплаты</h2>
    <label><input type="radio" name="payment" value="sbp" checked> СБП — Система быстрых платежей</label><br>
    <label><input type="radio" name="payment" value="card"> Карта — банковской картой онлайн</label><br><br>
    <button class="btn" id="pay">Оплатить</button>
    <p class="error" id="pay-error"></p>
  </div>`;
  const $ = (name) => app.querySelector(`[name="${name}"]`);
  const phone = $('phone'), select = $('phoneCountry'), flag = document.getElementById('flag');
  function setCountry(country) { state.country = country; select.value = country; flag.textContent = flags[country]; }
  function setNational(digits) {
    state.national = digits.slice(0, 11);
    if (state.national.startsWith('7')) setCountry('KZ');
    else if (state.national) setCountry('RU');
    phone.value = formatPhone(state.national);
  }
  // The «+7» cannot be deleted: whatever is typed after it is the national number, a «+7» typed again too.
  phone.addEventListener('input', () => {
    const v = phone.value;
    setNational((v.startsWith('+7') ? v.slice(2) : v).replace(/\\D/g, ''));
  });
  select.addEventListener('change', () => { setCountry(select.value); });
  setNational((profile.phone || '').replace(/^\\+7/, '').replace(/\\D/g, ''));
  // The city: suggestions a second after the last keystroke; typing again drops what was chosen.
  const city = $('city'), suggest = document.getElementById('suggest');
  let timer = null;
  function chooseCity(name) {
    state.city = name; city.value = name; suggest.classList.add('hidden');
    document.getElementById('city-error').textContent = '';
    state.stores = (window.STORES[name] || []);
    document.getElementById('methods').classList.remove('hidden');
  }
  function resetDelivery() {
    state.city = null; state.delivery = null; state.store = null;
    app.querySelectorAll('[name="delivery"]').forEach((r) => { r.checked = false; });
    document.getElementById('methods').classList.add('hidden');
    document.getElementById('stores').classList.add('hidden');
    document.getElementById('address').classList.add('hidden');
    document.getElementById('payment').classList.add('hidden');
    drawTotals();
  }
  city.addEventListener('input', () => {
    if (state.city !== null || state.delivery !== null) resetDelivery();
    clearTimeout(timer);
    suggest.classList.add('hidden');
    timer = setTimeout(async () => {
      const r = await api('GET', '/api/cities?q=' + encodeURIComponent(city.value));
      suggest.innerHTML = r.data.cities.map((c) => `<li role="option">${c}</li>`).join('');
      suggest.querySelectorAll('li').forEach((li) => { li.onclick = () => chooseCity(li.textContent); });
      if (r.data.cities.length) suggest.classList.remove('hidden');
    }, 1000);
  });
  function drawStores() {
    const box = document.getElementById('stores');
    box.innerHTML = state.stores.length ? state.stores.map((s) => `<div class="store ${state.store === s.id ? 'chosen' : ''}">
      <b>${s.name}</b><br>${s.address}<br>
      <button class="btn light" data-store="${s.id}">${state.store === s.id ? 'Выбран' : 'Выбрать'}</button></div>`).join('')
      : '<p>В этом городе нет магазинов.</p>';
    box.querySelectorAll('[data-store]').forEach((b) => { b.onclick = () => { state.store = b.dataset.store; drawStores(); }; });
  }
  function drawTotals() {
    const fee = state.delivery === 'courier' ? window.COURIER_FEE : 0;
    document.getElementById('fee').textContent = state.delivery === null ? '—' : fee ? fee + ' ₽' : 'бесплатно';
    document.getElementById('total').textContent = (cart.total + fee).toLocaleString('ru-RU') + ' ₽';
  }
  app.querySelectorAll('[name="delivery"]').forEach((radio) => radio.addEventListener('change', () => {
    state.delivery = radio.value; state.store = null;
    document.getElementById('stores').classList.toggle('hidden', radio.value !== 'pickup');
    document.getElementById('address').classList.toggle('hidden', radio.value !== 'courier');
    if (radio.value === 'pickup') drawStores();
    drawTotals();
  }));
  if (profile.city) chooseCity(profile.city);
  document.getElementById('to-pay').onclick = () => {
    const error = document.getElementById('form-error');
    error.textContent = '';
    if (!$('firstName').value || !$('email').value || state.national.length < 10) {
      error.textContent = 'Заполните имя, email и телефон'; return;
    }
    if (state.city === null) { document.getElementById('city-error').textContent = 'Выберите город из списка'; return; }
    document.getElementById('payment').classList.remove('hidden');
  };
  app.querySelectorAll('[name="payment"]').forEach((radio) => radio.addEventListener('change', () => { state.payment = radio.value; }));
  document.getElementById('pay').onclick = async () => {
    const payError = document.getElementById('pay-error');
    payError.textContent = '';
    const deliveryMethod = state.delivery === 'pickup' ? (state.store ? 'pickup' : undefined) : state.delivery || undefined;
    const r = await api('POST', '/api/orders', {
      customer: {firstName: $('firstName').value, lastName: $('lastName').value, email: $('email').value,
                 phone: '+7' + state.national, countryCode: state.country},
      city: state.city, deliveryMethod, storeId: state.store, address: $('address').value || undefined,
      paymentMethod: state.payment});
    if (r.status === 409) {
      payError.textContent = 'На ваш email был создан личный кабинет. Пароль выслан на почту.'; return;
    }
    if (!r.ok) { location.href = '/order/error'; return; }
    location.href = r.data.paymentUrl;
  };
}
start();
</script>
"""

ORDER_ERROR = """
<h1>Не удалось оформить заказ</h1>
<p>Попробуйте ещё раз или свяжитесь с нами.</p>
<p><a href="/cart">Вернуться в корзину</a></p>
"""

# An older order form the site still serves: whatever is sent, its API answers 400.
LEGACY_ORDER = """
<h1>Оформить заказ</h1>
<div class="field"><input name="name" placeholder="Имя"></div>
<div class="field"><input name="phone" type="tel" placeholder="Телефон"></div>
<div class="field"><input name="email" placeholder="Email"></div>
<div class="field"><select name="delivery"><option value="pickup">Самовывоз</option><option value="courier">Курьер</option></select></div>
<button class="btn" id="send">Оформить заказ</button>
<p class="error" id="error"></p>
<script>
document.getElementById('send').onclick = async () => {
  const value = (name) => document.querySelector(`[name="${name}"]`).value;
  const r = await api('POST', '/api/order', {name: value('name'), phone: value('phone'), email: value('email'),
                                             delivery: value('delivery')});
  document.getElementById('error').textContent = r.ok ? '' : 'Ошибка: Bad Request';
};
</script>
"""

PAYMENT = """
<h1>Оплата заказа №{order}</h1>
<p>К оплате: <b>{total}</b></p>
{body}
<script>
window.addEventListener('message', (event) => {{
  if (event.origin === '{pay}' && event.data && event.data.paid) location.href = '/order/success/{order}';
}});
</script>
"""

SBP = """
<p>Оплата через СБП: отсканируйте QR-код камерой телефона или в приложении банка.</p>
<svg width="160" height="160"><rect width="160" height="160" fill="#111"/><rect x="20" y="20" width="120" height="120" fill="#fff"/></svg>
<p><a href="/payment/{order}">Оплатить картой</a></p>
"""

# ЮKassa's card form, in its own origin: a masked number, the month and the year in boxes of two, the code.
PAY_FRAME = """<!doctype html><html lang=ru><head><meta charset=utf-8><title>ЮKassa</title>
<style>body{{font-family:Arial,sans-serif;margin:16px}} input{{padding:8px;margin:4px 0}} .error{{color:#c00}}</style></head><body>
<form onsubmit="return false">
  <label>Номер карты</label><div><input id="n" inputmode="numeric" maxlength="19" autocomplete="cc-number"></div>
  <div><span>Срок действия</span><div><input id="m" maxlength="2" inputmode="numeric" placeholder="ММ"> / <input id="y" maxlength="2" inputmode="numeric" placeholder="ГГ"></div></div>
  <div><span>Код</span><input id="c" type="password" maxlength="3" inputmode="numeric" placeholder="CVC"></div>
  <label><input type="checkbox"> Нужна квитанция</label>
  <div><button type="button" id="pay">Заплатить {total}</button></div>
  <p class="error" id="error"></p>
</form>
<script>
function digits(input, size, next) {{
  input.addEventListener('input', () => {{
    input.value = input.value.replace(/\\D/g, '').slice(0, size);
    if (input.value.length >= size && next) next.focus();
  }});
}}
n.addEventListener('input', () => {{
  const d = n.value.replace(/\\D/g, '').slice(0, 16);
  n.value = d.replace(/(\\d{{4}})(?=\\d)/g, '$1 ');
  if (d.length === 16) m.focus();
}});
digits(m, 2, y); digits(y, 2, c); digits(c, 3, null);
pay.onclick = async () => {{
  error.textContent = '';
  const response = await fetch('/api/pay', {{method: 'POST', headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{order: '{order}', number: n.value, month: m.value, year: y.value, cvc: c.value}})}});
  const data = await response.json();
  if (data.paid) {{ document.body.innerHTML = '<p>Платёж принят</p>'; parent.postMessage({{paid: true}}, '{shop}'); }}
  else error.textContent = data.message || 'Платёж отклонён';
}};
</script></body></html>"""


class Shop:
    """The shop's whole state: accounts, sessions (by cookie), carts, orders and the request log."""

    def __init__(self, *, account=True, saved_phone=False, saved_city=False):
        self.accounts = {}
        if account:
            self.accounts[EMAIL] = {"password": PASSWORD, "cart": {}, "profile": {
                "firstName": "Савелий", "lastName": "Соловьев",
                "phone": PHONE if saved_phone else None, "city": "Москва" if saved_city else None}}
        self.sessions = {}  # sid → {"user": email or None, "cart": {...} for a guest}
        self.orders = {}
        self.order_ids = itertools.count(FIRST_ORDER)
        self.log = []

    # --- harness helpers ---------------------------------------------------------------------------

    def new_session(self, user=None):
        sid = secrets.token_hex(12)
        self.sessions[sid] = {"user": user, "cart": {}}
        return sid

    def sign_out_everyone(self):
        """What a site does when it ends every session of the account (an expiry, a password reset)."""
        for session in self.sessions.values():
            session["user"] = None
            session["cart"] = {}

    def fill_cart(self, slug="vam-i-ne-snilos-30", qty=1, email=EMAIL):
        self.accounts[email]["cart"][slug] = qty

    def create_order(self, email=EMAIL, payment="card"):
        """An order already placed and waiting for its payment, as a run that stopped at the card left it."""
        order = self.place(email, {"firstName": "Савелий", "lastName": "Соловьев", "email": email, "phone": PHONE,
                                   "countryCode": "RU"}, "Москва", "pickup", "chistoprudny", None, payment,
                           {"vam-i-ne-snilos-30": 1})
        return order

    def requests(self, path=None, method=None):
        return [r for r in self.log if (path is None or re.fullmatch(path, r["path"]))
                and (method is None or r["method"] == method)]

    def paid_orders(self):
        return [o for o in self.orders.values() if o["status"] == "paid"]

    # --- state ---------------------------------------------------------------------------------------

    def session(self, request):
        sid = request.cookies.get("sid")
        if sid not in self.sessions:
            return None, None
        return sid, self.sessions[sid]

    def cart_of(self, session):
        if session is None:
            return {}
        if session["user"]:
            return self.accounts[session["user"]]["cart"]
        return session["cart"]

    def cart_view(self, cart):
        items = [{"slug": slug, "name": PRODUCTS[slug]["name"], "qty": qty, "price": PRODUCTS[slug]["price"],
                  "sum": rub(PRODUCTS[slug]["price"] * qty)} for slug, qty in cart.items()]
        total = sum(i["price"] * i["qty"] for i in items)
        return {"items": items, "total": total, "totalText": rub(total), "count": sum(cart.values())}

    def place(self, email, customer, city, delivery, store, address, payment, cart):
        order_id = str(next(self.order_ids))
        total = sum(PRODUCTS[slug]["price"] * qty for slug, qty in cart.items())
        total += COURIER_FEE if delivery == "courier" else 0
        self.orders[order_id] = {"id": order_id, "email": email, "customer": customer, "city": city,
                                 "deliveryMethod": delivery, "storeId": store, "address": address,
                                 "paymentMethod": payment, "items": dict(cart), "total": total,
                                 "status": "awaiting_payment"}
        return self.orders[order_id]

    # --- the shop's API ------------------------------------------------------------------------------

    def with_session(self, request, response):
        """A visitor without a session gets one, as the site's cookie does on the first page."""
        sid, _ = self.session(request)
        if sid is None:
            response.set_cookie("sid", self.new_session(), path="/", httponly=True)
        return response

    async def api_me(self, request):
        _, session = self.session(request)
        user = session["user"] if session else None
        profile = dict(self.accounts[user]["profile"]) if user else None
        return web.json_response({"user": user, "profile": profile,
                                  "cartCount": sum(self.cart_of(session).values())})

    async def api_login(self, request):
        body = await request.json()
        email = str(body.get("email") or "").strip().lower()
        account = self.accounts.get(email)
        if account is None or body.get("password") != account["password"]:
            return web.json_response({"statusCode": 401, "message": "Неверный email или пароль"}, status=401)
        sid, session = self.session(request)
        if session is None:
            sid = self.new_session()
            session = self.sessions[sid]
        # A guest's basket goes into the account's.
        for slug, qty in session["cart"].items():
            account["cart"][slug] = account["cart"].get(slug, 0) + qty
        session["cart"] = {}
        session["user"] = email
        response = web.json_response({"user": email})
        response.set_cookie("sid", sid, path="/", httponly=True)
        return response

    async def api_logout(self, request):
        _, session = self.session(request)
        if session:
            session["user"] = None
        return web.json_response({"ok": True})

    async def api_cart(self, request):
        sid, session = self.session(request)
        if session is None:
            sid = self.new_session()
            session = self.sessions[sid]
        cart = self.cart_of(session)
        if request.method == "POST":
            body = await request.json()
            slug = body.get("slug")
            if slug not in PRODUCTS:
                return web.json_response({"statusCode": 404, "message": "Product not found"}, status=404)
            cart[slug] = cart.get(slug, 0) + max(1, int(body.get("qty") or 1))
        response = web.json_response(self.cart_view(cart))
        response.set_cookie("sid", sid, path="/", httponly=True)
        return response

    async def api_cart_delete(self, request):
        _, session = self.session(request)
        self.cart_of(session).pop(request.match_info["slug"], None)
        return web.json_response(self.cart_view(self.cart_of(session)))

    async def api_cities(self, request):
        query = request.query.get("q", "").strip().lower()
        found = [c for c in CITIES if query and c.lower().startswith(query)] or \
                [c for c in CITIES if query and query in c.lower()]
        return web.json_response({"cities": found[:6]})

    async def api_orders(self, request):
        """The order, checked as the real API's DTO does (every message at once), then the account rule."""
        _, session = self.session(request)
        body = await request.json()
        customer = body.get("customer") if isinstance(body.get("customer"), dict) else {}
        messages = []
        delivery = body.get("deliveryMethod")
        if delivery not in ("pickup", "courier"):
            messages.append("deliveryMethod must be a valid enum value")
        if delivery == "pickup" and body.get("storeId") not in {s["id"] for s in STORES.get(body.get("city"), [])}:
            messages.append("storeId must be a valid store")
        if delivery == "courier" and not body.get("address"):
            messages.append("address should not be empty")
        if not isinstance(customer.get("countryCode"), str):
            messages.append("countryCode must be a string")
        phone = str(customer.get("phone") or "")
        if customer.get("countryCode") != "RU" or not re.fullmatch(r"\+79\d{9}", phone):
            messages.append("phone must be a valid phone number")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", str(customer.get("email") or "")):
            messages.append("email must be an email")
        if body.get("paymentMethod") not in ("sbp", "card"):
            messages.append("paymentMethod must be a valid enum value")
        if messages:
            return web.json_response({"statusCode": 400, "message": messages, "error": "Bad Request"}, status=400)
        user = session["user"] if session else None
        email = str(customer["email"]).strip().lower()
        if user is None and email in self.accounts:
            return web.json_response({"statusCode": 409, "message": "User already exist", "error": "Conflict"},
                                     status=409)
        cart = self.cart_of(session)
        if not cart:
            return web.json_response({"statusCode": 400, "message": ["cart should not be empty"],
                                      "error": "Bad Request"}, status=400)
        order = self.place(user or email, customer, body.get("city"), delivery, body.get("storeId"),
                           body.get("address"), body["paymentMethod"], cart)
        cart.clear()
        method = "?method=sbp" if body["paymentMethod"] == "sbp" else ""
        return web.json_response({"orderId": order["id"], "paymentUrl": f"/payment/{order['id']}{method}"})

    async def api_legacy_order(self, request):
        return web.json_response({"statusCode": 400, "error": "Bad Request", "message": [
            "deliveryMethod must be a valid enum value", "countryCode must be a string"]}, status=400)

    # --- pages ---------------------------------------------------------------------------------------

    async def home(self, request):
        return self.with_session(request, page("PREDUBEZHDAI", HOME))

    async def product(self, request):
        slug = request.match_info["slug"]
        if slug not in PRODUCTS:
            raise web.HTTPNotFound()
        p = PRODUCTS[slug]
        return self.with_session(request, page(p["name"], PRODUCT.format(
            name=p["name"], text=p["text"], price=rub(p["price"]), slug=slug)))

    async def cart_page(self, request):
        return self.with_session(request, page("Корзина", CART))

    async def checkout(self, request):
        globals_ = (f"<script>window.STORES = {json.dumps(STORES, ensure_ascii=False)};"
                    f"window.COURIER_FEE = {COURIER_FEE};</script>")
        return self.with_session(request, page("Оформление заказа", globals_ + CHECKOUT))

    async def order_error(self, request):
        return page("Ошибка", ORDER_ERROR)

    async def legacy_order(self, request):
        return self.with_session(request, page("Оформить заказ", LEGACY_ORDER))

    async def account(self, request):
        _, session = self.session(request)
        if not session or not session["user"]:
            return page("Личный кабинет", "<h1>Личный кабинет</h1><p>Войдите, чтобы увидеть заказы.</p>")
        mine = [o for o in self.orders.values() if o["email"] == session["user"]]
        rows = "".join(
            f"<p>Заказ №{o['id']} — {rub(o['total'])} — "
            + ("оплачен" if o["status"] == "paid" else f"ожидает оплаты <a href='/payment/{o['id']}'>Оплатить</a>")
            + "</p>" for o in mine) or "<p>Заказов пока нет.</p>"
        return page("Личный кабинет", f"""<h1>Личный кабинет</h1><p>{session['user']}</p><h2>Мои заказы</h2>{rows}
<button class="btn light" id="logout">Выйти</button>
<script>document.getElementById('logout').onclick = async () => {{ await api('POST', '/api/auth/logout'); location.href = '/'; }};</script>""")

    async def payment(self, request):
        order = self.orders.get(request.match_info["order"])
        if order is None:
            raise web.HTTPNotFound()
        if order["status"] == "paid":
            raise web.HTTPFound(f"/order/success/{order['id']}")
        if request.query.get("method") == "sbp":
            body = SBP.format(order=order["id"])
        else:
            body = (f'<iframe src="{PAY}/frame?order={order["id"]}" width="520" height="420" '
                    f'title="Оплата картой" style="border:1px solid #ccc"></iframe>')
        return page(f"Оплата заказа №{order['id']}", PAYMENT.format(order=order["id"], total=rub(order["total"]),
                                                                     body=body, pay=PAY))

    async def success(self, request):
        order = self.orders.get(request.match_info["order"])
        if order is None or order["status"] != "paid":
            raise web.HTTPNotFound()
        return page("Заказ оплачен", f"<h1>Оплата прошла, заказ №{order['id']}</h1><p>Сумма: {rub(order['total'])}. "
                                     "Мы пришлём письмо, когда заказ будет готов к выдаче.</p>")

    # --- the payment processor ----------------------------------------------------------------------

    async def pay_frame(self, request):
        order = self.orders.get(request.query.get("order", ""))
        if order is None:
            raise web.HTTPNotFound()
        return web.Response(text=PAY_FRAME.format(order=order["id"], total=rub(order["total"]), shop=SHOP),
                            content_type="text/html")

    async def api_pay(self, request):
        body = await request.json()
        order = self.orders.get(str(body.get("order")))
        if order is None:
            return web.json_response({"paid": False, "message": "Платёж не найден"}, status=404)
        number = re.sub(r"\D", "", str(body.get("number") or ""))
        given = (number, str(body.get("month") or ""), str(body.get("year") or ""), str(body.get("cvc") or ""))
        if given != (CARD["number"], CARD["month"], CARD["year"], CARD["cvc"]):
            return web.json_response({"paid": False, "message": "Платёж отклонён: проверьте данные карты"},
                                     status=402)
        order["status"] = "paid"
        return web.json_response({"paid": True})

    # --- serving -------------------------------------------------------------------------------------

    @web.middleware
    async def record(self, request, handler):
        body = None
        if request.can_read_body:
            raw = await request.read()
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw[:200].decode(errors="replace")
        entry = {"at": round(time.time(), 2), "host": request.host, "method": request.method, "path": request.path,
                 "query": request.query_string, "status": 500, "body": masked(body), "answer": None}
        if not request.path.startswith("/favicon"):
            self.log.append(entry)
        try:
            response = await handler(request)
        except web.HTTPException as error:
            entry["status"] = error.status
            raise
        entry["status"] = response.status
        if request.path.startswith("/api/") and isinstance(response, web.Response) and response.body:
            try:
                entry["answer"] = json.loads(response.body)
            except (TypeError, ValueError):
                pass
        return response

    def shop_app(self):
        app = web.Application(middlewares=[self.record])
        app.router.add_get("/", self.home)
        app.router.add_get("/product/{slug}", self.product)
        app.router.add_get("/cart", self.cart_page)
        app.router.add_get("/checkout", self.checkout)
        app.router.add_get("/order", self.legacy_order)
        app.router.add_get("/order/error", self.order_error)
        app.router.add_get("/account", self.account)
        app.router.add_get("/payment/{order}", self.payment)
        app.router.add_get("/order/success/{order}", self.success)
        app.router.add_get("/api/me", self.api_me)
        app.router.add_post("/api/auth/login", self.api_login)
        app.router.add_post("/api/auth/logout", self.api_logout)
        app.router.add_get("/api/cart", self.api_cart)
        app.router.add_post("/api/cart", self.api_cart)
        app.router.add_delete("/api/cart/{slug}", self.api_cart_delete)
        app.router.add_get("/api/cities", self.api_cities)
        app.router.add_post("/api/orders", self.api_orders)
        app.router.add_post("/api/order", self.api_legacy_order)
        return app

    def pay_app(self):
        app = web.Application(middlewares=[self.record])
        app.router.add_get("/frame", self.pay_frame)
        app.router.add_post("/api/pay", self.api_pay)
        return app

    async def start(self, host="127.0.0.1"):
        self.runners = []
        for app, port in ((self.shop_app(), SHOP_PORT), (self.pay_app(), PAY_PORT)):
            runner = web.AppRunner(app)
            await runner.setup()
            await web.TCPSite(runner, host, port).start()
            self.runners.append(runner)

    async def stop(self):
        for runner in getattr(self, "runners", []):
            await runner.cleanup()


def masked(body):
    """A request body for the log with the card number cut to its last four digits."""
    if isinstance(body, dict) and isinstance(body.get("number"), str):
        digits = re.sub(r"\D", "", body["number"])
        return {**body, "number": f"…{digits[-4:]}" if digits else ""}
    return body
