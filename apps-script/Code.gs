/**
 * ГАБ Сборщик — бот-«почтальон» для Google Таблицы.
 *
 * Что делает: каждое сообщение, пересланное в рабочую группу менеджеров,
 * складывает «как есть» на лист «Входящие» (текст, дата исходного поста,
 * автор, контакт, источник). ИИ здесь нет — разбор делает Claude по команде
 * «актуализируй», перенося объекты в рабочую таблицу (лист «МСК_Парсим»).
 *
 * Настройка — см. README.md в этой папке.
 */

// ─── Названия листов ────────────────────────────────────────────────────────
const SHEET_INBOX = 'Входящие';

// Сообщения, написанные прямо в группе (не пересланные), сохраняем,
// только если они длиннее этого порога — чтобы не тащить в таблицу болтовню.
const MIN_OWN_TEXT_LENGTH = 120;

const INBOX_HEADERS = [
  'ID',                 // A  chat_id:message_id — ключ от дублей
  'Получено',           // B  когда переслали в группу
  'Дата публикации',    // C  дата исходного поста
  'Кто переслал',       // D
  'Тип источника',      // E  пользователь / скрытый / канал / группа / своё
  'Автор',              // F
  'Контакт автора',     // G  @username, если Telegram его отдал
  'Источник',           // H  название канала/группы
  'Ссылка на оригинал', // I  только для публичных каналов
  'Ссылка в нашей группе', // J
  'Медиа',              // K  фото / документ / —
  'Текст',              // L
  'Статус',             // M  новое / обработано / пропущено / дубль
];


// ─── Приём сообщений от Telegram ────────────────────────────────────────────
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('WEBHOOK_SECRET');
    if (secret && (!e.parameter || e.parameter.secret !== secret)) {
      return ok_();
    }

    const update = JSON.parse(e.postData.contents);
    const msg = update.message || update.channel_post;
    if (!msg) return ok_();

    const allowed = props.getProperty('ALLOWED_CHAT_ID');
    if (allowed && String(msg.chat.id) !== allowed) return ok_();
    if (msg.chat.type === 'private') return ok_();

    // Запоминаем ID группы при первом сообщении — пригодится для ограничения.
    if (!props.getProperty('LAST_CHAT_ID')) {
      props.setProperty('LAST_CHAT_ID', String(msg.chat.id));
    }

    const text = msg.text || msg.caption || '';
    const isForward = !!(msg.forward_origin || msg.forward_date);
    if (!isForward && text.length < MIN_OWN_TEXT_LENGTH) return ok_();

    saveMessage_(msg, text);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
  return ok_();
}

function saveMessage_(msg, text) {
  const id = msg.chat.id + ':' + msg.message_id;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(id)) return; // Telegram повторил доставку
    const sheet = getInbox_();
    if (alreadySaved_(sheet, id)) { cache.put(id, '1', 21600); return; }

    const o = describeOrigin_(msg);
    sheet.appendRow([
      id,
      toDate_(msg.date),
      toDate_(o.date || msg.date),
      personName_(msg.from),
      o.type,
      o.author,
      o.contact,
      o.source,
      o.link,
      groupLink_(msg),
      mediaKind_(msg),
      text,
      text ? 'новое' : 'без текста',
    ]);
    cache.put(id, '1', 21600);
  } finally {
    lock.releaseLock();
  }
}

function describeOrigin_(msg) {
  const fo = msg.forward_origin;
  const r = { type: 'своё', author: personName_(msg.from), contact: username_(msg.from),
              source: '', link: '', date: null };
  if (!fo) {
    // Старый формат (на всякий случай)
    if (msg.forward_date) {
      r.type = 'переслано'; r.date = msg.forward_date;
      if (msg.forward_from) { r.author = personName_(msg.forward_from); r.contact = username_(msg.forward_from); }
      else if (msg.forward_sender_name) { r.author = msg.forward_sender_name; r.contact = ''; }
    }
    return r;
  }
  r.date = fo.date;
  switch (fo.type) {
    case 'user':
      r.type = 'пользователь';
      r.author = personName_(fo.sender_user);
      r.contact = username_(fo.sender_user);
      break;
    case 'hidden_user':
      r.type = 'скрытый профиль';
      r.author = fo.sender_user_name || '';
      r.contact = '';
      break;
    case 'channel':
      r.type = 'канал';
      r.author = fo.author_signature || '';
      r.contact = '';
      r.source = fo.chat.title || '';
      if (fo.chat.username) r.link = 'https://t.me/' + fo.chat.username + '/' + fo.message_id;
      break;
    case 'chat':
      r.type = 'группа';
      r.author = fo.author_signature || '';
      r.contact = '';
      r.source = fo.sender_chat.title || '';
      break;
  }
  return r;
}

// ─── Подготовка таблицы: запустить один раз вручную ─────────────────────────
function setup() {
  const inbox = getInbox_();
  styleHeader_(inbox, INBOX_HEADERS.length);
  inbox.setColumnWidth(12, 500);
  inbox.getRange('L:L').setWrap(true);
  inbox.getRange('B:C').setNumberFormat('dd.mm.yyyy hh:mm');

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('WEBHOOK_SECRET')) {
    props.setProperty('WEBHOOK_SECRET', Utilities.getUuid().replace(/-/g, ''));
  }
  notify_('Готово: лист «Входящие» настроен.');
}

// ─── Связка с Telegram: запустить после «Развернуть» ────────────────────────
function setWebhook() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BOT_TOKEN');
  const url = props.getProperty('WEB_APP_URL');
  if (!token || !url) throw new Error('Заполните BOT_TOKEN и WEB_APP_URL в свойствах скрипта.');
  let secret = props.getProperty('WEBHOOK_SECRET');
  if (!secret) { secret = Utilities.getUuid().replace(/-/g, ''); props.setProperty('WEBHOOK_SECRET', secret); }

  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      url: url + '?secret=' + secret,
      allowed_updates: ['message', 'channel_post'],
      drop_pending_updates: true,
    }),
    muteHttpExceptions: true,
  });
  console.log(res.getContentText());
  notify_('Ответ Telegram: ' + res.getContentText());
}

// Проверка: что Telegram знает о вебхуке (ошибки доставки и т.п.)
function checkWebhook() {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo');
  const info = JSON.parse(res.getContentText()).result || {};
  delete info.url; // не показываем секрет
  notify_(JSON.stringify(info, null, 2));
}

// Пункт меню в таблице
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ГАБ бот')
    .addItem('1. Подготовить лист', 'setup')
    .addItem('2. Подключить к Telegram', 'setWebhook')
    .addItem('Проверить связь', 'checkWebhook')
    .addToUi();
}

// ─── Вспомогательное ────────────────────────────────────────────────────────
function getInbox_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_INBOX);
  if (!sh) {
    sh = ss.insertSheet(SHEET_INBOX);
    sh.getRange(1, 1, 1, INBOX_HEADERS.length).setValues([INBOX_HEADERS]);
  }
  return sh;
}

function alreadySaved_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const from = Math.max(2, last - 300);
  const ids = sheet.getRange(from, 1, last - from + 1, 1).getValues();
  return ids.some(function (r) { return r[0] === id; });
}

function styleHeader_(sheet, n) {
  sheet.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#1f2a44')
    .setFontColor('#ffffff').setWrap(true).setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
}

function personName_(u) {
  if (!u) return '';
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

function username_(u) {
  return u && u.username ? '@' + u.username : '';
}

function groupLink_(msg) {
  if (msg.chat.username) return 'https://t.me/' + msg.chat.username + '/' + msg.message_id;
  const id = String(msg.chat.id);
  if (id.indexOf('-100') === 0) return 'https://t.me/c/' + id.slice(4) + '/' + msg.message_id;
  return '';
}

function mediaKind_(msg) {
  if (msg.photo) return 'фото';
  if (msg.video) return 'видео';
  if (msg.document) return 'документ';
  return '—';
}

function toDate_(unix) {
  return unix ? new Date(unix * 1000) : '';
}

// Сообщение: окном в таблице, а при запуске из редактора — в журнал
function notify_(text) {
  console.log(text);
  try { SpreadsheetApp.getUi().alert(text); } catch (e) { /* запуск из редактора */ }
}

function ok_() {
  return ContentService.createTextOutput('ok');
}
