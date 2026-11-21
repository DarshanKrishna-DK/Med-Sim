/**
 * MedSim -> Google Calendar bridge. Deploy as a Web app:
 * Execute as: Me, Who has access: Anyone. Set script property MEDSIM_SECRET.
 *
 * POST body (JSON):
 * { secret, title, description, location, startIso, minutes,
 *   recurrence: {freq: "DAILY"|"WEEKLY"|"MONTHLY", count: int, interval?: int} | null,
 *   guestEmail?: string }
 * Reply: {ok:true, id, seriesId?, htmlLink, startText} or {ok:false, error}
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
    var expected = PropertiesService.getScriptProperties().getProperty('MEDSIM_SECRET');
    if (!expected || body.secret !== expected) {
      return json_({ ok: false, error: 'unauthorized' });
    }
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
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
