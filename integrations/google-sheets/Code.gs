const SPREADSHEET_ID = '18czPOiutg1VrhNLJMV8iyDUD6I6ibq7sOgAK6zkvh1c';
const QC_ID_HEADER = 'QC_ID';

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: true, service: 'QuestControl Google Sheets' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const secret = PropertiesService.getScriptProperties().getProperty('QUESTCONTROL_SECRET');
    if (!secret || body.secret !== secret) return json_({ ok: false, error: 'UNAUTHORIZED' });
    if (body.type === 'connection.test') {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      return json_({ ok: true, sheets: ss.getSheets().map(function(sheet) { return sheet.getName(); }) });
    }
    if (!body.sessionId) return json_({ ok: false, error: 'INVALID_PAYLOAD' });

    lock.waitLock(20000);
    if (body.type === 'session.recorded') return recordSession_(body);
    if (body.type === 'session.rolled_back') return rollbackSession_(body);
    return json_({ ok: false, error: 'UNSUPPORTED_EVENT' });
  } catch (error) {
    console.error(error && error.stack || error);
    return json_({ ok: false, error: String(error && error.message || error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function recordSession_(body) {
  if (!body.date) return json_({ ok: false, error: 'INVALID_PAYLOAD' });
  const props = PropertiesService.getScriptProperties();
  const eventKey = 'questcontrol_session_' + body.sessionId;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const targetName = sheetNameFor_(body.roomName || '', body.game || '');
  const target = ss.getSheetByName(targetName);
  if (!target) return json_({ ok: false, error: 'SHEET_NOT_FOUND', sheet: targetName });

  const existingRow = findSessionRow_(target, body.sessionId, body.bookingId);
  if (existingRow) {
    props.setProperty(eventKey, JSON.stringify({ sheet: targetName, row: existingRow, at: new Date().toISOString() }));
    return json_({ ok: true, duplicate: true, sheet: targetName, row: existingRow });
  }

  const kasseRow = findKasseRow_(ss, body.date);
  if (!kasseRow) return json_({ ok: false, error: 'DATE_NOT_FOUND_IN_KASSE' });
  const row = addSessionRow_(target, targetName, body);
  const payment = addPaymentToKasse_(ss, body.date, number_(body.onlineAmount, body.total), body.paymentStatus, kasseRow);
  props.setProperty(eventKey, JSON.stringify({
    sheet: targetName, row: row, bookingId: body.bookingId || '', date: body.date,
    kasseRow: payment.row, kasseColumn: payment.column, amount: payment.amount, at: new Date().toISOString()
  }));
  return json_({ ok: true, sheet: targetName, row: row, kasse: payment });
}

function rollbackSession_(body) {
  const props = PropertiesService.getScriptProperties();
  const eventKey = 'questcontrol_session_' + body.sessionId;
  const stored = props.getProperty(eventKey);
  const meta = stored ? JSON.parse(stored) : { sheet: sheetNameFor_(body.roomName || '', body.game || '') };
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const target = ss.getSheetByName(meta.sheet);
  if (!target) return json_({ ok: false, error: 'SHEET_NOT_FOUND', sheet: meta.sheet });
  const row = findSessionRow_(target, body.sessionId, body.bookingId || meta.bookingId);
  if (!row) return json_({ ok: false, error: 'SESSION_ROW_NOT_FOUND' });

  const amount = number_(body.onlineAmount, body.total);
  const payment = addPaymentToKasse_(ss, body.date || meta.date, -amount, body.paymentStatus);
  target.deleteRow(row);
  props.deleteProperty(eventKey);
  return json_({ ok: true, removed: true, sheet: meta.sheet, row: row, kasse: payment });
}

function sheetNameFor_(roomName, game) {
  const value = (roomName + ' ' + game).toLowerCase();
  if (value.indexOf('krampus') !== -1) return 'KrampusHaus';
  if (value.indexOf('questbox') !== -1 || value.indexOf('escape box') !== -1) return 'Escape Box';
  return 'VR_2.0';
}

function addSessionRow_(sheet, sheetName, body) {
  const row = findInsertRow_(sheet, body.date);
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
  if (row > 1) {
    const width = Math.min(sheet.getMaxColumns(), 20);
    sheet.getRange(row - 1, 1, 1, width).copyTo(sheet.getRange(row, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sheet.getRange(row - 1, 1, 1, width).copyTo(sheet.getRange(row, 1), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  const date = dateValue_(body.date);
  const total = number_(body.total, 0);
  const players = number_(body.players, 0);
  const price = number_(body.price, 0);
  const discount = number_(body.discountAmount, 0);
  const duration = number_(body.durationMinutes, 0);
  const admin = body.administrator || '';
  const phone = body.phone || '';
  const note = note_(body);

  if (sheetName === 'VR_2.0') {
    const values = [[date, body.game || '', body.startTime || '', price, players, total, discount, body.discountReason || '', body.promoCode || '', '', '', '', total, '', phone, duration, 1, admin, note]];
    sheet.getRange(row, 1, 1, values[0].length).setValues(values);
  } else {
    const values = [[date, body.startTime || '', price, players, total, discount, body.discountReason || '', body.promoCode || '', '', '', total, '', phone, duration, 1, admin, note]];
    sheet.getRange(row, 1, 1, values[0].length).setValues(values);
  }
  sheet.getRange(row, 1).setNumberFormat('dd.MM.yyyy');
  writeRecordId_(sheet, row, body.sessionId, body.bookingId);
  return row;
}

function note_(body) {
  const details = [];
  if (body.discountAmount) details.push('Discount: ' + body.discountAmount);
  if (body.discountReason) details.push('Reason: ' + body.discountReason);
  if (body.promoCode) details.push('Promo: ' + body.promoCode);
  details.push('QuestControl session:' + body.sessionId);
  if (body.bookingId) details.push('booking:' + body.bookingId);
  return details.join(' | ');
}

function qcId_(sessionId, bookingId) {
  return 'session:' + sessionId + (bookingId ? ' | booking:' + bookingId : '');
}

function helperColumn_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const rows = Math.min(Math.max(sheet.getLastRow(), 1), 10);
  const headers = sheet.getRange(1, 1, rows, lastColumn).getDisplayValues();
  for (let row = 0; row < headers.length; row++) {
    for (let column = 0; column < headers[row].length; column++) {
      if (String(headers[row][column]).trim() === QC_ID_HEADER) return column + 1;
    }
  }
  const column = lastColumn + 1;
  sheet.getRange(1, column).setValue(QC_ID_HEADER);
  sheet.hideColumns(column);
  return column;
}

function writeRecordId_(sheet, row, sessionId, bookingId) {
  sheet.getRange(row, helperColumn_(sheet)).setValue(qcId_(sessionId, bookingId));
}

function findSessionRow_(sheet, sessionId, bookingId) {
  const last = sheet.getLastRow();
  if (!last) return 0;
  const helper = helperColumn_(sheet);
  const ids = sheet.getRange(1, helper, last, 1).getDisplayValues();
  const sessionMarker = 'session:' + sessionId;
  const bookingMarker = bookingId ? 'booking:' + bookingId : '';
  for (let i = 0; i < ids.length; i++) {
    const value = String(ids[i][0]);
    if (value.indexOf(sessionMarker) !== -1 || (bookingMarker && value.indexOf(bookingMarker) !== -1)) return i + 1;
  }

  // Compatibility with records created before the QC_ID helper column existed.
  const values = sheet.getRange(1, 1, last, sheet.getLastColumn()).getDisplayValues();
  const legacySession = 'QuestControl session:' + sessionId;
  const legacyBooking = bookingId ? 'booking:' + bookingId : '';
  for (let i = 0; i < values.length; i++) {
    const value = values[i].join(' | ');
    if (value.indexOf(legacySession) !== -1 || (legacyBooking && value.indexOf(legacyBooking) !== -1)) return i + 1;
  }
  return 0;
}

function findInsertRow_(sheet, isoDate) {
  const parts = String(isoDate).split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const last = Math.max(sheet.getLastRow(), 1);
  const values = sheet.getRange(1, 1, last, 1).getValues();
  let lastMonthRow = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i][0];
    if (value instanceof Date && value.getFullYear() === year && value.getMonth() + 1 === month) lastMonthRow = i + 1;
  }
  if (lastMonthRow) {
    sheet.insertRowsAfter(lastMonthRow, 1);
    return lastMonthRow + 1;
  }
  return last + 1;
}

function findKasseRow_(ss, isoDate) {
  const sheet = ss.getSheetByName('Kasse');
  if (!sheet) throw new Error('SHEET_NOT_FOUND: Kasse');
  const target = Utilities.formatDate(dateValue_(isoDate), Session.getScriptTimeZone(), 'dd.MM.yyyy');
  const last = Math.max(sheet.getLastRow(), 1);
  const display = sheet.getRange(1, 1, last, Math.min(3, sheet.getMaxColumns())).getDisplayValues();
  for (let i = 0; i < display.length; i++) {
    if (display[i].some(function(value) { return String(value).trim() === target; })) return i + 1;
  }
  return 0;
}

function normalized_(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function isCashPayment_(paymentStatus) {
  const status = normalized_(paymentStatus);
  return ['not paid', 'unpaid', 'cash', 'cash payment', 'pending payment'].indexOf(status) !== -1;
}

function findKasseColumn_(sheet, paymentStatus) {
  const cash = isCashPayment_(paymentStatus);
  const expected = cash ? ['in', 'cash in', 'cash', 'bar'] : ['online', 'card', 'karte'];
  const rows = Math.min(Math.max(sheet.getLastRow(), 1), 10);
  const columns = Math.max(sheet.getLastColumn(), 1);
  const values = sheet.getRange(1, 1, rows, columns).getDisplayValues();
  for (let row = 0; row < values.length; row++) {
    for (let column = 0; column < values[row].length; column++) {
      if (expected.indexOf(normalized_(values[row][column])) !== -1) return column + 1;
    }
  }
  // Current Kasse layout: date / day-begin / in / out / day-end / cashout / online.
  return cash ? 4 : 8;
}

function addPaymentToKasse_(ss, isoDate, amount, paymentStatus, existingRow) {
  const numericAmount = number_(amount, 0);
  if (!numericAmount) return { row: existingRow || 0, column: 0, amount: 0 };
  const sheet = ss.getSheetByName('Kasse');
  if (!sheet) throw new Error('SHEET_NOT_FOUND: Kasse');
  const row = existingRow || findKasseRow_(ss, isoDate);
  if (!row) throw new Error('DATE_NOT_FOUND_IN_KASSE: ' + isoDate);
  const column = findKasseColumn_(sheet, paymentStatus);
  const cell = sheet.getRange(row, column);
  cell.setValue(number_(cell.getValue(), 0) + numericAmount);
  return { row: row, column: column, amount: numericAmount };
}

function dateValue_(isoDate) {
  const p = String(isoDate).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
}

function number_(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}
