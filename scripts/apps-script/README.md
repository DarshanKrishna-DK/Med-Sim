# MedSim Google Calendar bridge (Apps Script)

Books follow-ups from the charge nurse straight into your own Google Calendar.

1. Open https://script.google.com and create a New project.
2. Replace the default file contents with `Code.gs` from this folder.
3. Project Settings > Script properties > Add `MEDSIM_SECRET` with a long random value.
4. Deploy > New deployment > type Web app > Execute as: Me, Who has access: Anyone.
5. Click Authorize access and approve the Calendar permission, then copy the Web app URL.
6. Put the URL in `GCAL_SCRIPT_URL` and the secret in `GCAL_SCRIPT_SECRET` in `backend/.env.local` and in the Render environment, then restart the backend.

Health check: open the Web app URL in a browser, it returns `{"ok":true,"service":"medsim-calendar"}`.
After editing the script, use Deploy > Manage deployments > Edit > New version.

## Report emails (Email.gs)

Priya at Reception emails a student's assignment report to the teacher through the same web app
(`backend/integrations/gcal_script.py` `send_email`, body `{"action":"email", secret, to, subject, html, text}`).

1. Add a second script file named `Email.gs` with the contents of `Email.gs` from this folder.
2. In `Code.gs` `doPost`, right after the `MEDSIM_SECRET` check, route the email action:

   ```js
   if (body.action === 'email') return json_(handleEmail_(body));
   ```

3. Run `handleEmailSelfTest_` once from the editor and approve the "Send email as you" permission.
4. Deploy > Manage deployments > Edit > New version.

`handleEmail_` calls `MailApp.sendEmail({to, subject, htmlBody, body})` and replies
`{ok:true, remaining: MailApp.getRemainingDailyQuota()}`. The backend only ever passes the
assignment's teacher email as `to`. If the script is not set up, the backend falls back to SMTP
(`SMTP_USER` / `SMTP_PASSWORD`) and otherwise reports that email is not available.
