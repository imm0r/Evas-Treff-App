# Eva's Treff

Der Familien-Hub: Fotoalben, Termine, Pinnwand, Rezepte, Gästeliste. Statische
Seite auf GitHub Pages, Daten in Supabase.

**Live:** https://imm0r.github.io/Evas-Treff-App/

In diesem Repository liegt **kein Foto und kein Geheimnis** — nur HTML,
JavaScript und die Tests dazu. Der Schlüssel in `app/supabase.js` ist der
öffentliche „publishable key"; ohne Anmeldung liefert er null Zeilen.

```
app/                        die Seite, die GitHub Pages ausliefert
supabase/migrations/        das Datenbankschema und die Zugriffsregeln
supabase/email-templates/   die zwei Mails, auf Deutsch
tools/                      Testsuiten, Migration, lokaler Server
```

Bereiche: **Alben** (`index.html`), **Hochladen** (`upload.html`),
**Termine** (`dates.html`), **Pinnwand** (`board.html`), **Rezepte**
(`rezepte.html`) und **Familie** (`admin.html`, nur für Admins — dort stehen
auch die Geburtstage).

---

A family hub for a couple of dozen relatives: announcements, photo albums
(videos too), dates and birthdays, a pinboard, recipes, and the guest list that
decides who may see any of it. A static page on GitHub Pages in
front of a Supabase project.

```
   +-----------------+          +------------------------------+
   |  static app     |  HTTPS   |  Supabase                    |
   |  GitHub Pages   +--------->|  Postgres + row level security|
   |  (public, no    |          |  Auth (magic links)          |
   |   secrets)      |          |  Storage (private buckets)   |
   +-----------------+          +------------------------------+
```

## Why it is built this way

**No backend of our own, and no build step.** Six HTML files, a handful of
scripts, one stylesheet. Supabase is reached over plain HTTP — PostgREST,
Storage and Auth are all just endpoints — rather than through the client
library, so there is nothing to compile and the Content-Security-Policy names
exactly one host.

One dependency, and only when it is needed: `vendor/libheif.wasm` converts
HEIC, which no Chromium browser can open — see below.

**No passwords anywhere.** You type your address, you get a link, you are in.
Nobody in this family should have to invent or remember a password, and a
password is the part of a login that gets reused, written down and leaked.
`create_user` is on, but a trigger rejects any signup whose address is not on
the guest list, so "anyone can request a link" does not mean "anyone can get
in".

**The guest list is the whole membership mechanism.** An invitation may also
name a face on the family photo, and then the app greets that person by name on
their very first visit — they never see a "wer bist du?" at all.

**Who you are is not typed.** The account carries the name, and every row
records its author server-side. Deleting your own photo or comment is a rule in
the database, not a hidden button: the server refuses anyone else, so the UI can
hide the button without pretending that is the protection.

**Faces instead of a name field.** Sign-in ties an account to a person on one
group photo, and from then on that person's face appears beside their name
everywhere — on tiles, in filter chips, over comments, on the pinboard. A
`people` row carries earlier spellings too (`aliases`), so correcting a name
does not split someone in two.

**Photos are shrunk on the phone, before upload.** A modern phone photo is
4–8 MB. Each one is re-encoded to a 2560px long edge (~400–700 KB) plus a 480px
thumbnail, so the grid costs kilobytes per photo and the upload survives a bad
connection. The re-encode also strips EXIF, which means **GPS coordinates never
leave the phone** — worth knowing, because most photos taken at home carry a
home address.

**The buckets are private, and images arrive as signed URLs.** One signing call
covers a whole album, however many photos are in it; after that the browser
fetches and caches them like any other image. That is one request per screen
instead of one per tile.

**A recipe is a line per ingredient, and nothing is guessed out of it.**
Ingredients and steps are one text field each; a line becomes a bullet, an
empty line becomes nothing. What the app deliberately does *not* do is split
"500 g Mehl" into an amount and an ingredient. Family recipes say "eine Prise",
"2–3 Äpfel", "Mehl bis es geht" — every split of that is a guess, and a guess
that is wrong on Oma's card is worse than no column at all. It can grow a
parser later; it cannot un-mangle what it stored wrong.

**One main picture, and more if you like.** There is no `is_cover` flag and no
second column on the recipe: two places holding the same truth drift apart. The
main picture is simply the one with the lowest `sort_order`, and "make this the
main one" moves it below all the others — one `UPDATE`, not a renumbering loop
that can stop halfway and leave two covers or none. A new picture goes to the
*end* of the row, so the first one uploaded stays the face of the recipe rather
than the last step photo silently taking over.

Photos may be reordered by whoever owns the *recipe*, not only by whoever
uploaded the picture — otherwise nobody could fix the cover once two people had
contributed. That rule is a policy in the database, proven against it in a
rolled-back transaction: own recipe yes, someone else's no, a stranger's photo
on my recipe yes, the same photo on their recipe no.

**The database never speaks to the family directly.** Typing 4113 into "für
wie viele Personen?" used to put `new row for relation "recipes" violates check
constraint "recipes_servings_check"` on somebody's phone. For the person
holding it that is not a sentence, it is a fright. Three things changed:

* The form checks the range itself. `min`/`max` on a number input stops
  neither typing nor reading the value back, so the check has to be in the
  code, and it names the allowed span rather than the rule.
* Whatever still comes back from Postgres is translated. The constraint name
  carries the column, so `recipes_servings_check` becomes *„Bei ‚für wie viele
  Personen' passt der Wert nicht."*; a column nobody has named yet falls back
  to a general sentence — vaguer, but never raw and never wrong.
* Errors now carry `status` and the SQLSTATE `code`. Callers branch on the
  code, never on the German text, so the wording stays free to change without
  quietly breaking a code path.

**Two things may share a name.** "Weihnachten" happens every year and every
family cooks Kartoffelsalat twice, but the slug is unique because it is in the
URL. The second one used to get *„Das gibt es schon."* and a dead end; now it
becomes `-2`. On the server's refusal rather than a lookup first: two people
creating at the same moment would both pass a lookup and one would still fail.

**Notifications reach people who are not looking.** The news page only catches
you once you open the app of your own accord; "Die Oma ist wieder zu Hause"
should arrive without anyone having to check. So an announcement now wakes a
database trigger, which wakes an edge function, which sends a Web Push to every
device that asked for one.

The encryption is written by hand rather than pulled from `npm:web-push`, and
the reason is testability, not purity: a push cannot be delivered to a real
phone from a build machine, so a library integration could only ever be hoped
at. RFC 8291 §5, by contrast, publishes a complete worked example — fixed keys,
fixed salt, and the exact expected body. `npm run check:push` recomputes it and
compares byte for byte. (Its stated `Content-Length: 145` is wrong; the printed
body is 144 bytes. That is the RFC's own erratum 5230, filed by its author —
checked rather than shrugged off.)

Three things shape the feature:

* **Per device, not per person.** Phone, tablet and laptop are three
  subscriptions. Turning it on in one place does not turn it on elsewhere.
* **The iPhone needs the home screen.** Apple only allows Web Push once the
  page is installed, so on an iPhone in a Safari tab `PushManager` is simply
  absent. The page says so, with the two steps, instead of offering a button
  that would do nothing.
* **The service worker caches nothing.** It exists solely to receive pushes.
  A worker that serves files from its own store keeps handing out yesterday's
  version even after a hard reload — that confusion already happened here once
  during a deploy, and building it in permanently would be a poor trade for a
  slightly faster start.

Dead subscriptions are deleted when a push service answers 404 or 410, and only
devices that actually accepted a message get their "last reached" stamped —
otherwise the very column you would use to spot a silent phone would lie.

**The news page interrupts you, and that is the point.** A pinboard post waits
to be found; an announcement stands in the way. That difference is the whole
feature — so announcements are admin-only, because a post that stops eleven
people is not the same thing as one they scroll past.

Entering the site checks once and steps aside to `neues.html` when there is
something. Only *unread* things trigger it. An announcement can carry an
"until" date, and then it stays readable on the page after you have seen it
without ever stopping you again — otherwise the choice would be between the
barbecue notice ambushing you daily and it vanishing after one glance.

Read announcements do not disappear, they step aside. The page shows only what
is unread or still current — otherwise every visit would open with the whole
family chronicle — and a **"Frühere Mitteilungen"** section at the bottom loads
the rest on demand, skipping whatever is already shown above. Without it "Die
Oma ist wieder zu Hause" would be invisible forever after one glance, while the
row sat in the database the whole time. On demand rather than on load, because
this page sits in everyone's way into the app.

Below the announcements, what happened by itself: new photos, comments,
recipes, events, all since your last visit and never your own doing. The page
contains **only** what actually exists — no empty headings, no "0 new photos".
A section with nothing in it is not rendered at all.

It is one round trip, not five. `news_for_me()` answers the whole question in
one call, `SECURITY INVOKER` so it sees exactly what the caller may see, and
what "new" means lives in one place instead of being spread across five
callers. The redirect is guarded by a session flag: if marking-as-seen ever
failed, an unguarded check would bounce the family between two pages forever,
and a broken news query must never block the albums.

**Videos go up untouched, and the still frame is what makes that safe.**
Photos are shrunk on the device; a video cannot be, so what was filmed is what
gets stored. That leaves one unpleasant truth: iPhones film in HEVC/`.mov`,
which plays on Apple devices and often not at all in Chrome or Firefox
elsewhere. Rejecting the format would lock half the family out of uploading, so
instead the uploader's browser pulls a **still frame** out of the video before
it goes anywhere. That frame is an ordinary JPEG thumbnail, so the gallery looks
right even for a viewer who cannot play the file — and that viewer gets a
sentence saying why, plus the download, instead of a black rectangle.

The still is taken half a second in, not at zero: cameras start dark and settle
their exposure afterwards, so frame zero is usually black. If the uploader's own
browser cannot decode the file, that is discovered *here* — before a single byte
crosses the network.

Freshly recorded video reports its length as `Infinity` until something seeks to
the end, because a recorder only writes the duration once it finishes. Without
that detour every video filmed on a phone would show no running time at all.

Two limits are deliberate. **200 MB per video**, checked before the upload
starts rather than after: the upload runs in one shot with no resume, so the cap
is about what survives a shaky mobile connection, not about the plan's 100 GB.
And duplicate detection hashes only the **first megabyte plus the file size** —
reading 200 MB into memory to hash it is how you crash an older phone.

**One album is not a dead end.** With exactly one album the app opens it
straight away — that is what the links already in the family's group chat do,
and a shelf holding one card is a pointless stop. But "Neues Album" lives on
the shelf, so for a while the shortcut meant a second album could not be
created at all: the shelf was never reached and the way back was hidden
"because there is nothing to go back to". The shortcut stayed; the way out is
now always offered, and `?alben` forces the shelf.

**A photo can change album, and only that.** Tidying up happens after the
upload — somebody empties their phone, and half of it turns out to belong to
Easter rather than the birthday. Moving is a plain `album_id` update by the
uploader or an admin, the same rule as deleting. The file itself stays where it
was written: the path carries the old album's name and nobody sees it, whereas
copying an object to a prettier path is a chance to lose it. Row level security
cannot restrict columns, so the column grant does — `grant update (album_id)`
and nothing else, or the same person could rewrite `uploader_id` and the
authorship every other rule rests on would be decoration.

**"There is something new on that picture."** The ask was *where*, not merely
*that*, so it is tracked per photo: a row in `comment_reads` appears the moment
somebody actually opens a photo's thread — not when they scroll past it — and
what you have read is visible to you alone. In a family, "I can see that you
saw it" is not a feature, it is an accusation. A floor in the profile
(`comments_seen_at`, set to now for everyone the migration touched) keeps thirty
old comments from all lighting up at once, and keeps the shelf's count cheap:
it only ever asks for comments newer than the floor. The shelf counts pictures
rather than comments, because a picture is somewhere you can go.

**Dates are a list, not a month grid.** A calendar grid on a phone is mostly
empty boxes, and the question is never "what was on the 14th" but "what is
next". So: one list, nearest first, and anything past today drops off — in the
query, not in the browser. Birthdays sit in that same list although they come
from another table and belong to nobody; on screen they are the same thing, a
date to look forward to.

**A date can last several days**, because "Jahrestreffen 2027: 5.–10.8." is
exactly the kind of thing entered a year in advance. `ends_on` is a second
column rather than a length in days: "until the 10th" is what people say and
write down, while "six days" has to be worked out once and again on every edit.
NULL means one day, so nothing already entered had to have an ending invented
for it.

The interesting part is the query. "What is not over yet" now has to keep a date
whose *start* is behind us — the family gathering must still be there on its
third day. Written across two columns that is
`starts_on >= today or ends_on >= today`, and there is something wrong with it:
for a one-day date `ends_on` is NULL, so the second half is NULL and the whole
expression is NULL rather than false. In a `WHERE` the row still drops out, so
the result is right — but only because three-valued logic happens to point the
same way, and a later `NOT` would flip it silently. That was measured against
this database, not assumed: the truth table for all seven cases came back with
NULL for "one-day, past". So the answer is computed once and stored —
`over_on = coalesce(ends_on, starts_on)` — and the filter reads like the
question it asks.

A birthday is a day and a month, and the **year is optional**, because for the
older relatives nobody remembers it. With a year the card says "wird 78";
without one it just says whose day it is. An invented year would show up later
as an age, which is worse than no age at all. The database insists on the pair
— a day without a month is not a date — and the page says so first, in German,
before sending anything.

Replies are one row per person per event, upserted, so changing your mind
replaces the earlier answer instead of stacking up. The card shows the faces of
everyone who said yes, from the same family photo the rest of the app uses.

**Photos are named by their content.** `albums/<slug>/<hash>.jpg`, with a
`_thumb.jpg` beside it. Re-uploading the same file lands on the same name and
is skipped, and the row is written only after both objects are up: a file with
no row is invisible, a row with no file is a tile that opens into nothing.

## Setup

Both halves already exist; this is what to do if you ever rebuild them.

### 1. The Supabase project

Any region. Apply `supabase/migrations/` in order — that creates `people`,
`invites`, `profiles`, `albums`, `photos`, `comments` and `board_posts`, all
with row level security on, plus the two private buckets `photos` and `people`.
Each file says why it exists; the ones that only revoke a grant are there
because the database linter found something, and the comment names what.

Put the project URL and the **publishable** key in `app/supabase.js`, and the
same host in the `connect-src` and `img-src` of every page's CSP.

### 2. Authentication

- **Site URL**: the Pages URL, e.g. `https://imm0r.github.io/Evas-Treff-App/`
- **Redirect URLs**: add `https://imm0r.github.io/Evas-Treff-App/**` — the app
  asks to come back to the page you started on, so a link opened on a phone
  lands where you were rather than always on the front page.
- **Templates**: paste the two from `supabase/email-templates/`. The stock ones
  are English and say "finish signing up", which is both the wrong language and
  the wrong idea — nobody signs up here, everybody is already invited.

### 2b. Custom SMTP — not optional

**Without it the family cannot log in at all.** Supabase's built-in mailer
refuses to deliver to any address that is not a member of the project's own
team, and it allows only a couple of messages an hour on top of that. The
project owner gets their link and concludes it works; everybody else waits for
a mail that was never sent, with no error anywhere they can see.

Any provider with a free tier does the job for a family of eleven — Brevo,
Resend, Mailgun, or a Gmail app password. Credentials go in
**Authentication → Emails → SMTP Settings**: host `smtp.gmail.com`, port 465,
the mailbox address as the user, and an **app password** rather than the account
password. Set the sender name to `Evas Treff`. Raise the rate limit on the same
page too: the default with custom SMTP is 30 new users per hour, which is plenty
here but worth knowing before a rollout.

The same mailbox can serve several projects — a Gmail app password is not tied
to one. Give each project **its own** app password though: Google lets you mint
as many as you like and revoke them one at a time, so rotating one project's
sender cannot silently stop the family from logging in. The ~500 messages a day
are shared across everything using that mailbox, which at eleven relatives is
not a number anybody will meet.

Verified the hard way: a link was mailed to the project owner and read back out
of the inbox. That is also how the `redirect_to` bug below turned up.

If the auth log says `535 5.7.8 Username and Password not accepted`, the
connection is fine and only the login was refused — almost always the account
password where an app password belongs, or an app password minted while a
different Google account was signed in. The username must be the full address.

### 3. The first admin

One row in `invites` with `is_admin = true`. Everyone after that can be invited
from the **Familie** page.

### 4. Publish the app

- Settings → Pages → Source: **GitHub Actions**
- Actions → *Deploy* → **Run workflow**

…or copy `app/` anywhere else that serves static files. There is no build.

## Limitations

- **From `file://`** the pages load, but `crypto.subtle` needs a secure context,
  so uploads fall back to a non-cryptographic content fingerprint (fine for
  naming, still deduplicates). `npm run serve` gives you a proper
  `http://localhost`.
- **HEIC** is converted on the device. No Chromium browser can decode it —
  not `<img>`, not `createImageBitmap` — so the app carries libheif compiled to
  WebAssembly and does it itself. That megabyte is fetched only when someone
  actually picks a HEIC, and the upload page's CSP allows `wasm-unsafe-eval`
  for it. The capture date is read out of the HEIF container too, or every
  iPhone photo would be filed under the day it was copied off the phone.
- **Deleting is final.** The row goes, its comments cascade, the files follow.
  There is no history to restore from any more.
- **Leaked-password protection is off**, because it needs a paid plan. It also
  protects nothing here: there are no passwords.

## Tests

```
npm install && npx playwright install chromium
npm test
```

Three checks, all of which measure the code against something other than itself:

- `tools/exif-test.mjs` — hand-assembled JPEG headers in both byte orders,
  including the ones that must return "no idea": dead camera clocks, dates in
  the future, and every possible truncation of a valid file.
- `tools/e2e-supabase.mjs` — a real Chromium against a stubbed Supabase. Covers
  what only exists at runtime: the magic link's tokens being scrubbed from the
  address bar (and working when the page is already open), twenty photos costing
  the same number of signing calls as two, a 12 MP photo actually arriving as a
  2560px JPEG, a HEIC arriving as one at all, uploading the same file twice
  being a no-op, the delete button appearing only on your own things, the guest
  list refusing a non-admin, the calendar asking only for dates from today
  onwards and sorting birthdays in among the events, a still frame that really
  came out of a video rather than a black square, a recipe's ingredients
  surviving as the lines somebody typed, an empty time arriving as
  `null` rather than `00:00`, a date that has started still being listed while
  one that has ended is not, a single album still reaching the shelf so a
  second one can be created, a move sending `album_id` and nothing else, the
  unread mark appearing only on the picture that has one and clearing when the
  thread is opened, and a signed-out page requesting nothing at all.
- Before any of that, **every page is opened once with a full backend** and must
  come up clean — no console error *and* no error box. A module calling into
  another whose file the page forgot to load dies with "Cannot read properties
  of undefined", and that is exactly how `neues.html` shipped: the only page not
  loading `album.js`, which `people.js` calls into. Two things made it slip
  through. The page's own `try/catch` turned the crash into a red box rather
  than an uncaught error, so a guard listening only to the console waved it
  past; and `people.js` returns early when no face map is loaded, which no test
  had bothered to provide, so the call was never reached. The guard now fails on
  the box too, and it runs early — sitting after the tests that die on the same
  fault, it could never have been shown to work.
- `tools/query-check.mjs` (`npm run check:api`) — every query the app makes,
  put to the real Supabase without a session. *Every* one: it walks whatever is
  on `PS.data` rather than a hand-kept list, because the hand-kept list went
  stale the moment recipes were added and quietly went on checking the old
  set. Database functions are checked the same way — a renamed one answers 404,
  and without this the family would be the ones to find out. A stub can only confirm what it
  was taught: it hands back canned JSON and never reads the `select`, so it
  cannot know whether PostgREST could answer it. This runs `app/js/data.js`
  itself, with a `PS` that records queries instead of sending them, and then
  asks the live project. Row level security answers `[]` to all of them, but
  the shape of a query is checked *before* that — a broken one comes back 300
  or 400. It exists because one did: the calendar asked for `profiles` on
  `events`, which PostgREST refuses, because `events.created_by` and the
  `event_replies` junction are two different paths between the same two
  tables. The tests were green and the page was blank.

`SHOTS=<dir> node tools/e2e-supabase.mjs` also writes a picture of every screen.
Assertions keep missing what one look catches immediately, and screenshots have
found more layout bugs in this app than the tests have.
