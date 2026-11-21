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
