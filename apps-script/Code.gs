/**
 * ГАБ Сборщик — бот-«почтальон» для Google Таблицы. Версия 4.
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

const INBOX_HEADERS = [
  'ID', 'Получено', 'Дата публикации', 'Кто переслал', 'Тип источника',
  'Автор', 'Контакт автора', 'Источник', 'Ссылка на оригинал',
  'Ссылка в нашей группе', 'Медиа', 'Текст', 'Статус', 'Альбом', 'Папка в Битриксе', 'Копия для разбора',
];

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('WEBHOOK_SECRET');
    if (secret && (!e.parameter || e.parameter.secret !== secret)) {
      console.warn('Пропуск: неверный секрет');
      return ok_();
    }

    const update = JSON.parse(e.postData.contents);
    const msg = update.message || update.channel_post;
    if (!msg) { console.log('Пропуск: нет сообщения, ключи: ' + Object.keys(update).join(',')); return ok_(); }

    const allowed = props.getProperty('ALLOWED_CHAT_ID');
    if (allowed && String(msg.chat.id) !== allowed) { console.log('Пропуск: чужой чат ' + msg.chat.id); return ok_(); }
    if (msg.chat.type === 'private') { console.log('Пропуск: личный чат'); return ok_(); }

    const text = msg.text || msg.caption || '';
    const isForward = !!(msg.forward_origin || msg.forward_date);
    console.log('Сообщение: чат=' + msg.chat.id + ' пересылка=' + isForward +
                ' длина текста=' + text.length + ' фото=' + !!msg.photo);
    const hasMedia = !!(msg.photo || msg.video || msg.document);
    if (!isForward && !hasMedia && text.length < MIN_OWN_TEXT_LENGTH) { console.log('Пропуск: короткое своё сообщение'); return ok_(); }

    saveMessage_(msg, text);
    console.log('Записано');
  } catch (err) {
    console.error('Ошибка: ' + (err && err.stack ? err.stack : err));
  }
  return ok_();
}

function saveMessage_(msg, text) {
  const id = msg.chat.id + ':' + msg.message_id;
  const cache = CacheService.getScriptCache();
  if (cache.get(id)) return;
  cache.put(id, '1', 21600);

  let links = { bitrix: '', google: '' };
  try { links = saveMedia_(msg); }
  catch (err) { links.google = 'ошибка медиа: ' + err; console.error('Медиа: ' + err); }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getInbox_();
    if (alreadySaved_(sheet, id)) return;
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
      msg.media_group_id || '',
      links.bitrix,
      links.google,
    ]);
  } finally {
    lock.releaseLock();
  }
}

// ─── Медиа: скачать из Telegram и положить в папку объекта ──────────────────
function saveMedia_(msg) {
  let file = null, name = '';
  if (msg.photo) { file = msg.photo[msg.photo.length - 1]; name = 'фото_' + msg.message_id + '.jpg'; }
  else if (msg.video) { file = msg.video; name = msg.video.file_name || ('видео_' + msg.message_id + '.mp4'); }
  else if (msg.document) { file = msg.document; name = msg.document.file_name || ('файл_' + msg.message_id); }
  const links = { bitrix: '', google: '' };
  if (!file) return links;

  if (file.file_size && file.file_size > TG_MAX_FILE) {
    const note = 'Файл «' + name + '» больше 20 МБ — Telegram не даёт боту его скачать. Смотрите в группе.';
    links.google = objectFolder_(msg).getUrl();
    objectFolder_(msg).createFile('СЛИШКОМ_БОЛЬШОЙ_ФАЙЛ_' + msg.message_id + '.txt', note);
    return links;
  }
  const blob = downloadFromTelegram_(file.file_id).setName(name);

  // Служебная копия на Google Диск — чтобы Claude мог прочитать фото
  try {
    const gFolder = objectFolder_(msg);
    gFolder.createFile(blob);
    links.google = gFolder.getUrl();
  } catch (err) { links.google = 'ошибка Google: ' + err; console.error('Google: ' + err); }

  // Основное хранение — Битрикс24
  if (PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK')) {
    try {
      const b = bitrixObjectFolder_(msg);
      bitrix_('disk.folder.uploadfile', {
        id: b.id,
        data: { NAME: name },
        fileContent: [name, Utilities.base64Encode(blob.getBytes())],
        generateUniqueName: true,
      });
      links.bitrix = b.url;
    } catch (err) { links.bitrix = 'ошибка Битрикс: ' + err; console.error('Битрикс: ' + err); }
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
  return Utilities.formatDate(toDate_(msg.date), 'Europe/Moscow', 'yyyy-MM-dd HH-mm') + ' — ' +
         (describeOrigin_(msg).author || 'объект');
}

// Подпапка объекта в Битриксе (одна на альбом)
function bitrixObjectFolder_(msg) {
  const props = PropertiesService.getScriptProperties();
  const key = 'B_' + (msg.media_group_id || (msg.chat.id + '_' + msg.message_id));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const known = props.getProperty(key);
    if (known) return JSON.parse(known);
    const root = props.getProperty('BITRIX_FOLDER_ID');
    if (!root) throw new Error('сначала запустите bitrixSetup');
    const f = bitrix_('disk.folder.addsubfolder', { id: root, data: { NAME: folderTitle_(msg) } });
    const v = { id: f.ID, url: f.DETAIL_URL };
    props.setProperty(key, JSON.stringify(v));
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
function objectFolder_(msg) {
  const props = PropertiesService.getScriptProperties();
  const key = 'F_' + (msg.media_group_id || (msg.chat.id + '_' + msg.message_id));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const known = props.getProperty(key);
    if (known) return DriveApp.getFolderById(known);
    const folder = rootFolder_().createFolder(folderTitle_(msg));
    props.setProperty(key, folder.getId());
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
