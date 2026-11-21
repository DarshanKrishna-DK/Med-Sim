/**
 * MedSim -> Google Workspace bridge. Deploy as a Web app:
 * Execute as: Me, Who has access: Anyone. Optional script property MEDSIM_SECRET.
 *
 * OAuth scopes (authorised on first run / new deployment version):
 *   https://www.googleapis.com/auth/calendar          (CalendarApp)
 *   https://www.googleapis.com/auth/spreadsheets      (SpreadsheetApp, logbook)
 *   https://www.googleapis.com/auth/documents         (DocumentApp, referral)
 *   https://www.googleapis.com/auth/drive             (DriveApp, folders and PDF export)
 *
 * POST body (JSON), switched on `action` (missing or "calendar" = calendar):
 *
 * action "calendar" (default):
 * { secret, title, description, location, startIso, minutes,
 *   recurrence: {freq: "DAILY"|"WEEKLY"|"MONTHLY", count: int, interval?: int} | null,
 *   guestEmail?: string }
 * Reply: {ok:true, id, seriesId?, htmlLink, startText} or {ok:false, error}
 *
 * action "logbook": append a row to the "MedSim Clinical Logbook" sheet (created on
 * first use, id kept in script property LOGBOOK_ID).
 * { action:"logbook", secret, row:{date, student, university, specialty, caseName, patient,
 *   diagnosis, skills, tests, prescriptions, score, facultySignoff, notes} }
 * Reply: {ok:true, sheetUrl, row} or {ok:false, error}
 *
 * action "referral": Google Doc "Referral: <patient> to <specialty>", exported as PDF into
 * the Drive folder "MedSim Referrals".
 * { action:"referral", secret, patient, specialty, urgency, reason, situation, background,
 *   assessment, recommendation, label }
 * Reply: {ok:true, docUrl, pdfUrl} or {ok:false, error}
 */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: true, service: 'medsim-calendar' });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    // Optional shared secret: if the MEDSIM_SECRET script property is set it must
    // match. Without it, the unguessable web-app URL itself is the key.
    var expected = PropertiesService.getScriptProperties().getProperty('MEDSIM_SECRET');
    if (expected && body.secret !== expected) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    var action = String(body.action || 'calendar').toLowerCase();
    if (action === 'logbook') return json_(logbook_(body));
    if (action === 'referral') return json_(referral_(body));
    if (action !== 'calendar') return json_({ ok: false, error: 'unknown action' });
    return calendar_(body);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function calendar_(body) {
    var start = new Date(body.startIso);
    if (isNaN(start.getTime())) return json_({ ok: false, error: 'bad startIso' });
    var minutes = Math.max(5, Math.min(240, Number(body.minutes) || 20));
    var end = new Date(start.getTime() + minutes * 60000);
    var title = String(body.title || 'MedSim follow-up').slice(0, 200);
    var options = {
      description: String(body.description || '').slice(0, 4000),
      location: String(body.location || '').slice(0, 300)
    };
    var guest = body.guestEmail ? String(body.guestEmail).trim() : '';
    if (guest && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guest)) {
      options.guests = guest;
      options.sendInvites = true;
    }

    var cal = CalendarApp.getDefaultCalendar();
    var ev, seriesId = null, rec = body.recurrence;
    if (rec && rec.freq) {
      var count = Math.max(1, Math.min(52, parseInt(rec.count, 10) || 1));
      var interval = Math.max(1, Math.min(12, parseInt(rec.interval, 10) || 1));
      var r = CalendarApp.newRecurrence();
      var freq = String(rec.freq).toUpperCase();
      if (freq === 'DAILY') r = r.addDailyRule().interval(interval).times(count);
      else if (freq === 'WEEKLY') r = r.addWeeklyRule().interval(interval).times(count);
      else if (freq === 'MONTHLY') r = r.addMonthlyRule().interval(interval).times(count);
      else return json_({ ok: false, error: 'bad recurrence.freq' });
      ev = cal.createEventSeries(title, start, end, r, options);
      seriesId = ev.getId();
    } else {
      ev = cal.createEvent(title, start, end, options);
    }
    ev.addPopupReminder(30);
    ev.addEmailReminder(1440);

    var id = ev.getId();
    var htmlLink = 'https://calendar.google.com/calendar/r';
    try {
      var raw = id.split('@')[0] + ' ' + cal.getId();
      htmlLink = 'https://calendar.google.com/calendar/r/eventedit/' +
        Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
    } catch (err) { /* keep generic link */ }

    var out = {
      ok: true,
      id: id,
      htmlLink: htmlLink,
      startText: Utilities.formatDate(start, Session.getScriptTimeZone(), 'EEE d MMM, h:mm a')
    };
    if (seriesId) out.seriesId = seriesId;
    return json_(out);
}

var LOGBOOK_NAME = 'MedSim Clinical Logbook';
var LOGBOOK_HEADER = ['Date', 'Student', 'University', 'Clinic/Specialty', 'Case', 'Patient (synthetic)',
  'Diagnosis', 'Skills performed', 'Tests ordered', 'Prescriptions', 'Score', 'Faculty sign-off', 'Notes'];

// Stop spreadsheet formula injection: text starting with = + - @ gets a leading apostrophe.
function cell_(v) {
  var t = (v === null || v === undefined) ? '' : String(v);
  t = t.slice(0, 1000);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function logbookSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('LOGBOOK_ID');
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(LOGBOOK_NAME);
    props.setProperty('LOGBOOK_ID', ss.getId());
    var first = ss.getSheets()[0];
    first.setName('Logbook');
    first.getRange(1, 1, 1, LOGBOOK_HEADER.length).setValues([LOGBOOK_HEADER]).setFontWeight('bold');
    first.setFrozenRows(1);
  }
  return ss;
}

function logbook_(body) {
  var r = body.row || {};
  var ss = logbookSheet_();
  var sheet = ss.getSheets()[0];
  var date = r.date ? String(r.date) : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  sheet.appendRow([
    cell_(date), cell_(r.student), cell_(r.university), cell_(r.specialty), cell_(r.caseName),
    cell_(r.patient), cell_(r.diagnosis), cell_(r.skills), cell_(r.tests), cell_(r.prescriptions),
    cell_(r.score), cell_(r.facultySignoff), cell_(r.notes)
  ]);
  return { ok: true, sheetUrl: ss.getUrl(), row: sheet.getLastRow() };
}

function referral_(body) {
  var patient = String(body.patient || 'Patient').slice(0, 120);
  var specialty = String(body.specialty || 'Specialist').slice(0, 120);
  var title = 'Referral: ' + patient + ' to ' + specialty;
  var doc = DocumentApp.create(title);
  var d = doc.getBody();
  var label = String(body.label || 'SIMULATION, synthetic patient').slice(0, 200);
  d.appendParagraph(label).setBold(true);
  d.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  d.appendParagraph('Urgency: ' + String(body.urgency || 'routine'));
  d.appendParagraph('Reason: ' + String(body.reason || '').slice(0, 1000));
  var parts = [['Situation', body.situation], ['Background', body.background],
    ['Assessment', body.assessment], ['Recommendation', body.recommendation]];
  for (var i = 0; i < parts.length; i++) {
    d.appendParagraph(parts[i][0]).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    d.appendParagraph(String(parts[i][1] || '').slice(0, 3000));
  }
  d.appendParagraph(label).setItalic(true);
  doc.saveAndClose();
  var file = DriveApp.getFileById(doc.getId());
  var folders = DriveApp.getFoldersByName('MedSim Referrals');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('MedSim Referrals');
  var pdf = folder.createFile(file.getAs('application/pdf').setName(title + '.pdf'));
  file.moveTo(folder);
  return { ok: true, docUrl: doc.getUrl(), pdfUrl: pdf.getUrl() };
}
