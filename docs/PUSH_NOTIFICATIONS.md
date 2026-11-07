# Phone notifications for staff

What it does: a phone that has turned on **Alerts** in the staff dashboard gets a notification when a customer places an
order, sends an inquiry (booking, table, massage, event, message) or changes an order. When the dashboard is installed
as an app (Add to Home Screen) the icon also shows the number of things waiting (pending orders + new inquiries).

## How it fits together

1. `manifest.webmanifest` (customers) and `qsnqpbzovgcamaqq.webmanifest` (staff) make the site installable.
2. `sw.js` (the service worker) shows the notification and sets the icon number when a push arrives.
3. The staff dashboard **Alerts** button asks permission and saves the phone in `push_subscriptions`.
4. Triggers on `orders` and `inquiries` (migration `0027_push_notifications.sql`) call the `send-push` edge function
   (`supabase/functions/send-push/index.ts`), which sends the message to every active staff phone.

## One-time setup

1. Run `supabase/migrations/0027_push_notifications.sql` in the Supabase SQL Editor.
2. Store the shared secret for the trigger (run once, with your own value; never commit it):
   `insert into public.push_config (key, value) values ('webhook_secret', '<PUSH_WEBHOOK_SECRET>') on conflict (key) do update set value = excluded.value;`
3. Deploy the edge function `send-push` (Supabase > Edge Functions, or `supabase functions deploy send-push --no-verify-jwt`).
   Turn **off** "Verify JWT" for it: the database trigger calls it with the shared secret instead.
4. Add these Edge Function secrets (Supabase > Edge Functions > Secrets):
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (for example `mailto:you@example.com`), `PUSH_WEBHOOK_SECRET`
   (the same value as in step 2). The public key is also in `assets/js/staff.js` (`VAPID_PUBLIC_KEY`).
   Make a new key pair with: `npx web-push generate-vapid-keys` (then replace the public key in `staff.js`).

## On each phone

- **Android (Chrome):** open the staff page, menu > Add to Home screen (or Install app), open it, press **Alerts: off**, allow notifications.
- **iPhone (Safari, iOS 16.4+):** Share > Add to Home Screen, open the **Staff** icon from the Home Screen, press **Alerts: off**, allow.
- The number on the icon is a red circle on iPhone; Android shows a dot (some launchers show the number).

## Notes

- Notifications use the phone's own sound. The custom dings only play while the dashboard page is open.
- Subscriptions of phones that removed the app or the permission are deleted automatically.
- If a notification does not arrive, check that the Alerts button says "on", the phone is not in battery saver, and Supabase > Edge Functions > send-push > Logs.
