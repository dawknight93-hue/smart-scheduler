export function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-2xl px-5 py-10 space-y-5 text-sm leading-relaxed">
        <h1 className="text-2xl font-semibold text-white">Smart Scheduler — Privacy Policy</h1>
        <p className="text-slate-400">Last updated: September 23, 2026</p>
        <p>
          Smart Scheduler is a personal scheduling app used by its owner. It is not offered to the
          public.
        </p>
        <h2 className="text-lg font-semibold text-white">What data the app accesses</h2>
        <p>
          When you connect a Google account, the app requests access to your Google Calendar (to read
          events from the calendars you choose and to create, update, and delete the events the app
          schedules) and to your Google account email address (to show which account is connected).
        </p>
        <h2 className="text-lg font-semibold text-white">How the data is used and stored</h2>
        <p>
          Calendar data is used only to build and display your schedule and to keep your Google
          Calendar in sync with it. Event details, the connected email address, and the Google OAuth
          tokens needed to keep syncing are stored in the app's private database. The data is not
          sold, shared with third parties, or used for advertising.
        </p>
        <h2 className="text-lg font-semibold text-white">Removing access</h2>
        <p>
          You can stop syncing at any time with Disconnect in the app's Calendar Connections panel,
          and you can revoke the app's access to your Google account at{" "}
          <a className="text-blue-400 underline" href="https://myaccount.google.com/permissions">
            myaccount.google.com/permissions
          </a>
          .
        </p>
        <h2 className="text-lg font-semibold text-white">Contact</h2>
        <p>Questions can be sent to the support email shown on the Google sign-in consent screen.</p>
      </div>
    </div>
  );
}
