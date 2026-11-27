/**
 * ГАБ Сборщик — бот-«почтальон» для Google Таблицы. Версия 8.
 * Сообщения забираются из Telegram каждые 5 минут (getUpdates по таймеру):
 * вебхук Apps Script отвечает Telegram кодом 302, и тот бесконечно повторяет доставку.
 * Текст постов — на лист «Входящие». Фото/видео/PDF — в Битрикс24
 * (Общий диск → Объекты МСК → ГАБ медиа из таблицы) и служебная копия на Google Диск.
 */

const SPREADSHEET_ID = '18YCy0pkS-3mSarf9XVHmg8wcuLdW7e7JO-P0X_Z0y9Q';
const SHEET_INBOX = 'Входящие';
const MIN_OWN_TEXT_LENGTH = 120;
const MEDIA_FOLDER_NAME = 'ГАБ медиа (копия для разбора)';
const BITRIX_PARENT_NAME = 'Объекты МСК';        // папка на Общем диске Битрикса
const BITRIX_FOLDER_NAME = 'ГАБ медиа из таблицы'; // её создаст скрипт
const TG_MAX_FILE = 20 * 1024 * 1024; // Telegram отдаёт ботам файлы до 20 МБ
const GROUP_WINDOW_SEC = 120; // посты одного автора, пересланные в пределах 2 минут, — один объект

const INBOX_HEADERS = [
  'ID', 'Получено', 'Дата публикации', 'Кто переслал', 'Тип источника',
  'Автор', 'Контакт автора', 'Источник', 'Ссылка на оригинал',
  'Ссылка в нашей группе', 'Медиа', 'Текст', 'Статус', 'Объект', 'Папка в Битриксе', 'Копия для разбора',
];

// Журнал на отдельном листе: облачные логи для запусков от Telegram не видны
function log_(text) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sh = ss.getSheetByName('Журнал') || ss.insertSheet('Журнал');
    sh.appendRow([new Date(), String(text).slice(0, 500)]);
  } catch (e) { console.error(e); }
}

// ─── Забор сообщений по таймеру ──────────────────────────────────────────────
// Запустить ОДИН раз вручную: отключает вебхук и ставит таймер на каждые 5 минут.
function startPolling() {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/deleteWebhook?drop_pending_updates=false',
    { muteHttpExceptions: true });
  notify_('Вебхук отключён: ' + r.getContentText());
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(5).create();
  notify_('Таймер включён: бот проверяет группу каждые 5 минут.');
  poll();
}

function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // предыдущий запуск ещё работает
  const started = Date.now();
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('BOT_TOKEN');
    let offset = Number(props.getProperty('UPDATE_OFFSET') || 0);
    const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates?timeout=0&limit=50' +
      '&allowed_updates=' + encodeURIComponent('["message","channel_post"]') + (offset ? '&offset=' + offset : ''),
      { muteHttpExceptions: true });
    const body = JSON.parse(r.getContentText());
    if (!body.ok) { log_('getUpdates: ' + body.description); return; }
    lock.releaseLock(); // дальше блокировки берутся точечно
    for (let i = 0; i < body.result.length; i++) {
      if (Date.now() - started > 4 * 60 * 1000) break; // остальное — в следующий запуск
      const u = body.result[i];
      try { handleUpdate_(u); } catch (err) { log_('ОШИБКА: ' + (err && err.stack ? err.stack : err)); }
      props.setProperty('UPDATE_OFFSET', String(u.update_id + 1));
    }
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function handleUpdate_(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return;
  if (msg.chat.type === 'private') { log_('Пропуск: личный чат с ботом'); return; }
  const allowed = PropertiesService.getScriptProperties().getProperty('ALLOWED_CHAT_ID');
  if (allowed && String(msg.chat.id) !== allowed) { log_('Пропуск: чужой чат ' + msg.chat.id); return; }

  const text = msg.text || msg.caption || '';
  const isForward = !!(msg.forward_origin || msg.forward_date);
  const hasMedia = !!(msg.photo || msg.video || msg.document);
  log_('Сообщение ' + msg.message_id + ' из «' + (msg.chat.title || msg.chat.id) + '»: пересылка=' + isForward +
       ', текст=' + text.length + ' симв., медиа=' + mediaKind_(msg));
  if (!isForward && !hasMedia && text.length < MIN_OWN_TEXT_LENGTH) { log_('Пропуск: короткое своё сообщение'); return; }
  saveMessage_(msg, text);
  log_('Записано: ' + msg.message_id);
}

// Старый вход через вебхук — оставлен на случай, если вебхук снова включат
function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (secret && (!e.parameter || e.parameter.secret !== secret)) return ok_();
  try { handleUpdate_(JSON.parse(e.postData.contents)); }
  catch (err) { log_('ОШИБКА: ' + err); }
  return ok_();
}

function saveMessage_(msg, text) {
  const id = msg.chat.id + ':' + msg.message_id;
  const cache = CacheService.getScriptCache();
  if (cache.get(id)) { log_('Повтор от Telegram, пропуск ' + id); return; }
  cache.put(id, '1', 21600);

  const key = objectKey_(msg);
  let links = { bitrix: '', google: '' };
  try { links = saveMedia_(msg, key); }
  catch (err) { links.google = 'ошибка медиа: ' + err; log_('Медиа: ' + err); }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getInbox_();
    if (alreadySaved_(sheet, id)) { log_('Уже есть в таблице: ' + id); return; }
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
      text || links.google || links.bitrix ? 'новое' : 'без текста',
      key,
      links.bitrix,
      links.google,
    ]);
  } finally {
    lock.releaseLock();
  }
}

// ─── Медиа: скачать из Telegram и положить в папку объекта ──────────────────
function saveMedia_(msg, key) {
  let file = null, name = '';
  if (msg.photo) { file = msg.photo[msg.photo.length - 1]; name = 'фото_' + msg.message_id + '.jpg'; }
  else if (msg.video) { file = msg.video; name = msg.video.file_name || ('видео_' + msg.message_id + '.mp4'); }
  else if (msg.document) { file = msg.document; name = msg.document.file_name || ('файл_' + msg.message_id); }
  const links = { bitrix: '', google: '' };
  if (!file) return links;

  if (file.file_size && file.file_size > TG_MAX_FILE) {
    const note = 'Файл «' + name + '» больше 20 МБ — Telegram не даёт боту его скачать. Смотрите в группе.';
    links.google = objectFolder_(msg, key).getUrl();
    objectFolder_(msg, key).createFile('СЛИШКОМ_БОЛЬШОЙ_ФАЙЛ_' + msg.message_id + '.txt', note);
    if (PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK')) {
      try { links.bitrix = bitrixObjectFolder_(msg, key).url; } catch (err) { log_('Битрикс: ' + err); }
    }
    log_('Файл больше 20 МБ, не скачан: ' + name);
    return links;
  }
  const blob = downloadFromTelegram_(file.file_id).setName(name);

  // Служебная копия на Google Диск — чтобы Claude мог прочитать фото
  try {
    const gFolder = objectFolder_(msg, key);
    gFolder.createFile(blob);
    links.google = gFolder.getUrl();
  } catch (err) { links.google = 'ошибка Google: ' + err; log_('Google: ' + err); }

  // Основное хранение — Битрикс24
  if (PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK')) {
    try {
      const b = bitrixObjectFolder_(msg, key);
      bitrix_('disk.folder.uploadfile', {
        id: b.id,
        data: { NAME: name },
        fileContent: [name, Utilities.base64Encode(blob.getBytes())],
        generateUniqueName: true,
      });
      links.bitrix = b.url;
    } catch (err) { links.bitrix = 'ошибка Битрикс: ' + err; log_('Битрикс: ' + err); }
  }
  return links;
}

function downloadFromTelegram_(fileId) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  // muteHttpExceptions: чтобы токен из адреса не попал в текст ошибки
  const r1 = UrlFetchApp.fetch('https://api.telegram.org/bot' + token +
    '/getFile?file_id=' + encodeURIComponent(fileId), { muteHttpExceptions: true });
  const info = JSON.parse(r1.getContentText());
  if (!info.ok) throw new Error('getFile: ' + (info.description || r1.getResponseCode()));
  const r2 = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + token + '/' + info.result.file_path,
    { muteHttpExceptions: true });
  if (r2.getResponseCode() !== 200) throw new Error('скачивание: код ' + r2.getResponseCode());
  return r2.getBlob();
}

// ─── Битрикс24 ──────────────────────────────────────────────────────────────
function bitrix_(method, params) {
  const hook = PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK').replace(/\/?$/, '/');
  let res;
  try {
    res = UrlFetchApp.fetch(hook + method + '.json', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(params || {}), muteHttpExceptions: true,
    });
  } catch (err) {
    throw new Error(method + ': нет связи с Битриксом'); // без адреса вебхука в тексте
  }
  const body = JSON.parse(res.getContentText() || '{}');
  if (body.error) throw new Error(method + ': ' + body.error + ' ' + (body.error_description || ''));
  return body.result;
}

function folderTitle_(msg) {
  const o = describeOrigin_(msg);
  return Utilities.formatDate(toDate_(o.date || msg.date), 'Europe/Moscow', 'yyyy-MM-dd HH-mm') + ' — ' +
         (o.author || 'объект');
}

// Ключ объекта (одна папка и одна группа строк в таблице):
// — альбом целиком;
// — фото/видео без текста от того же автора в пределах 2 минут — к предыдущему объекту;
// — текст присоединяется к предыдущему объекту, только если у того ещё нет текста;
// — PDF/документ всегда отдельный объект (обычно это отдельная презентация).
function objectKey_(msg) {
  const props = PropertiesService.getScriptProperties();
  const o = describeOrigin_(msg);
  const who = (o.contact || o.author || o.source || '?');
  const slot = 'LAST_' + msg.chat.id + '_' + (msg.from ? msg.from.id : 'x');
  const last = JSON.parse(props.getProperty(slot) || 'null');
  const hasText = (msg.text || msg.caption || '').length >= 50;
  const near = last && last.w === who && msg.date - last.t <= GROUP_WINDOW_SEC;
  let key, objHasText = hasText;
  if (msg.document) key = msg.chat.id + '_' + msg.message_id;
  else if (msg.media_group_id && last && last.g === msg.media_group_id) { key = last.k; objHasText = last.x || hasText; }
  else if (near && !last.d && !(hasText && last.x)) { key = last.k; objHasText = last.x || hasText; }
  else key = msg.chat.id + '_' + msg.message_id;
  props.setProperty(slot, JSON.stringify({ w: who, t: msg.date, k: key, g: msg.media_group_id || '',
                                           x: objHasText, d: !!msg.document }));
  return key;
}

// Подпапка объекта в Битриксе (одна на альбом)
function bitrixObjectFolder_(msg, key) {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const known = props.getProperty('B_' + key);
    if (known) return JSON.parse(known);
    const root = props.getProperty('BITRIX_FOLDER_ID');
    if (!root) throw new Error('сначала запустите bitrixSetup');
    let f;
    try { f = bitrix_('disk.folder.addsubfolder', { id: root, data: { NAME: folderTitle_(msg) } }); }
    catch (err) {
      if (String(err).indexOf('DISK_OBJ_22000') < 0) throw err; // папка с таким именем уже есть
      f = bitrix_('disk.folder.addsubfolder', { id: root, data: { NAME: folderTitle_(msg) + ' #' + msg.message_id } });
    }
    const v = { id: f.ID, url: f.DETAIL_URL };
    props.setProperty('B_' + key, JSON.stringify(v));
    return v;
  } finally {
    lock.releaseLock();
  }
}

// Запустить один раз: находит «Объекты МСК» на Общем диске и создаёт там папку
function bitrixSetup() {
  const props = PropertiesService.getScriptProperties();
  const storages = bitrix_('disk.storage.getlist', { filter: { ENTITY_TYPE: 'common' } });
  if (!storages || !storages.length) throw new Error('Общий диск не найден');
  const storage = storages[0];
  const top = bitrix_('disk.storage.getchildren', { id: storage.ID }) || [];
  const parent = top.filter(function (x) { return x.TYPE === 'folder' && x.NAME.trim() === BITRIX_PARENT_NAME; })[0];
  if (!parent) {
    notify_('Папка «' + BITRIX_PARENT_NAME + '» не найдена в корне «' + storage.NAME + '». Есть такие: ' +
            top.filter(function (x) { return x.TYPE === 'folder'; }).map(function (x) { return x.NAME; }).join(' | '));
    return;
  }
  const inside = bitrix_('disk.folder.getchildren', { id: parent.ID }) || [];
  let target = inside.filter(function (x) { return x.TYPE === 'folder' && x.NAME === BITRIX_FOLDER_NAME; })[0];
  if (!target) target = bitrix_('disk.folder.addsubfolder', { id: parent.ID, data: { NAME: BITRIX_FOLDER_NAME } });
  props.setProperty('BITRIX_FOLDER_ID', String(target.ID));
  notify_('Готово: папка «' + BITRIX_FOLDER_NAME + '» → ' + target.DETAIL_URL);
}

// Одна папка на объект: все фото/видео одного альбома попадают в неё
function objectFolder_(msg, key) {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const known = props.getProperty('F_' + key);
    if (known) return DriveApp.getFolderById(known);
    const folder = rootFolder_().createFolder(folderTitle_(msg));
    props.setProperty('F_' + key, folder.getId());
    return folder;
  } finally {
    lock.releaseLock();
  }
}

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('MEDIA_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder(MEDIA_FOLDER_NAME);
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  props.setProperty('MEDIA_FOLDER_ID', folder.getId());
  return folder;
}

function describeOrigin_(msg) {
  const fo = msg.forward_origin;
  const r = { type: 'своё', author: personName_(msg.from), contact: username_(msg.from),
              source: '', link: '', date: null };
  if (!fo) {
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

function setup() {
  const inbox = getInbox_();
  inbox.getRange(1, 1, 1, INBOX_HEADERS.length).setValues([INBOX_HEADERS]);
  styleHeader_(inbox, INBOX_HEADERS.length);
  rootFolder_();
  inbox.setColumnWidth(12, 500);
  inbox.getRange('L:L').setWrap(true);
  inbox.getRange('B:C').setNumberFormat('dd.mm.yyyy hh:mm');

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('WEBHOOK_SECRET')) {
    props.setProperty('WEBHOOK_SECRET', Utilities.getUuid().replace(/-/g, ''));
  }
  notify_('Готово: лист «Входящие» и папка «' + MEDIA_FOLDER_NAME + '» настроены.');
}

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
    }),
    muteHttpExceptions: true,
  });
  notify_('Ответ Telegram: ' + res.getContentText());
}

function checkWebhook() {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo');
  const info = JSON.parse(res.getContentText()).result || {};
  delete info.url;
  notify_(JSON.stringify(info, null, 2));
}

// Проверка записи без Telegram: добавляет тестовую строку
function testWrite() {
  getInbox_().appendRow(['test:' + Date.now(), new Date(), new Date(), 'тест', 'своё', '', '', '', '', '', '—',
                         'Тестовая строка — можно удалить', 'пропущено', '', '', '']);
  notify_('Тестовая строка добавлена на лист «Входящие».');
}

function getInbox_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
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

// Только журнал — без всплывающих окон, чтобы запуск не «зависал»
function notify_(text) {
  console.log(text);
}

function ok_() {
  return ContentService.createTextOutput('ok');
}
