/**
 * MedSim report email (Apps Script side of backend/integrations/gcal_script.py send_email).
 *
 * Add this file next to Code.gs in the same Apps Script project. Code.gs doPost
 * checks the shared secret, then routes body.action === 'email' here:
 *
 *   if (body.action === 'email') return json_(handleEmail_(body));
 *
 * Body: { action: 'email', secret, to, subject, html, text }.
 * Returns { ok: true, remaining } or { ok: false, error }.
 * Needs the "Send email as you" (MailApp) permission: run handleEmailSelfTest_ once
 * from the editor to authorize, then deploy a new version.
 */

var EMAIL_MAX_HTML_ = 200000;

function handleEmail_(body) {
  var to = String((body && body.to) || '').trim();
  var subject = String((body && body.subject) || 'MedSim report').slice(0, 200);
  var html = String((body && body.html) || '');
  var text = String((body && body.text) || '');
  if (!/^[^@\s<>"',;]+@[^@\s<>"',;]+\.[A-Za-z]{2,}$/.test(to)) {
    return { ok: false, error: 'invalid recipient' };
  }
  if (!html && !text) return { ok: false, error: 'empty message' };
  if (html.length > EMAIL_MAX_HTML_) html = html.slice(0, EMAIL_MAX_HTML_);
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'daily email quota used up' };
  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: html || undefined,
    body: text || 'Open this email in an HTML capable client to see the MedSim report.',
    name: 'MedSim Reception',
  });
  return { ok: true, remaining: MailApp.getRemainingDailyQuota() };
}

/** Run once from the editor to grant the MailApp permission (emails yourself). */
function handleEmailSelfTest_() {
  var me = Session.getActiveUser().getEmail();
  return handleEmail_({ to: me, subject: 'MedSim email bridge test', html: '<b>MedSim email bridge works.</b>', text: 'MedSim email bridge works.' });
}
