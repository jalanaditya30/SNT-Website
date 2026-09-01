# SNT Near Expiry

Near-expiry catalogue and secured admin import centre for Shree Narayani Traders, served
from `shreenarayanitraders.com/near-expiry/` alongside the main site.

Nothing on the main site links here — it is shared by link with trade contacts, and both
pages carry `noindex` with a matching `robots.txt` rule. That keeps it out of search
results; it is not an access control. Anyone holding the URL can read the catalogue, exactly
as before. The admin page is protected by Supabase Auth, as it always was.

## Pages

- `index.html` — public search tool: token search across product, company, salt and batch, shelf-life
  filtering, sorting, grid/list layouts, favourites and one-tap WhatsApp sharing.
- `admin.html` — Supabase-authenticated inventory, Excel/CSV import with a pre-flight
  validation preview, bulk photo/WhatsApp ZIP inbox and CRUD. Reached from the
  **SNT staff sign-in** link in the catalogue footer, or directly at
  `shreenarayanitraders.com/near-expiry/admin.html`.

## Using the catalogue

- Search matches every word in any order — `pan tablets`, `paracetamol dolo`, a company name
  and a batch number all work. Press `/` to jump to the search box.
- Each product shows its remaining shelf life, colour-coded: red under 3 months, amber under
  6, green beyond.
- **Saved** keeps a shortlist in the browser; **Share** sends the product details, and the
  original photo where the phone supports it, to WhatsApp.
- Opening a product and tapping its photo shows the original full-size image, with **Copy
  image** (paste straight into a WhatsApp chat) and **Save**. Tap the image again to zoom to
  actual size.

Expiry is a calendar month, and is formatted from the stored digits rather than through a
timestamp, so `2026-08-01` reads as `Aug/26` in every timezone. Shelf life counts whole months
to the end of the expiry month, so the expiry label and the shelf-life badge always agree.

## Matching a sheet to the catalogue

Distributor sheets do not name products the way the SNT master does — `ALCOXIB 120 10S`
against `ALCOXIB 120 (10'S)`, `ALDIGESIC 100 TAB 20X10` against `ALDIGESIC 100 Tab`. Exact
matching found six products in a real 184-row sheet, and since both the salt and the pack
photo hang off the master name, almost the whole benefit of the catalogue went with it.

Reading a sheet now opens a match dialog listing every product with the closest catalogue
name, its confidence, its salt and its photo. The name settled on there is the one published,
so accepting a match is what pulls the salt and the website photo through. On that sheet it
takes the import from 6 products with a salt to 114, and from none with a photo to 91.

The company is a gate, not a hint. A sheet line saying LUPIN is scored only against Lupin
products; one saying ALKEM-FUT never reaches an Alkem-Maxxio product, and one saying a company
the master has never heard of gets no suggestions at all rather than the nearest-looking
medicine from somebody else. Sheet codes and master spellings are reduced to a family and,
where one is named, a division — `ALKEM-FUT` and `Alkem - Futura / NEXX` are the same thing —
through a table in `matching.js` that is deliberately explicit: a new company is an edit there
and a test, never a quiet guess.

Inside that boundary, matches are scored on shared words weighted by how rare each is across
the master. A word in half the catalogue says nothing and a word in two products says almost
everything; without that weighting `ALKEM COLD + SUS` matches `ALKEM COLD ACTIVE TAB` on the
strength of the word ALKEM rather than `NEW ALKEM COLD + SUSPENSION`. Dose and dosage form are
decisive: ALCOXIB 120 is never ALCOXIB 90, ALMOX 125 MG is never the 250 MG tablet, and a
shared brand never makes an injection out of a tablet.

**Only a match that is both strong and clear of its runner-up is filled in** — 80% with a
seven-point lead, or a name that reduces to exactly the catalogue's. Everything else is listed
with its candidates and left blank on purpose. A 94% top candidate one point ahead of a 93%
one is not a match, it is a flavour, a strength or a pack the sheet did not name, and
pre-filling it is how that decision gets made by nobody. Those rows are tinted, marked
**Suggested — check it**, sorted to the top of the list and counted on the button beside
Import. Each row shows the sheet's own product and company, the score, the gap to the
runner-up, and the catalogue product's composition and company.

A suggestion is never a dead end. Each row's field searches the whole master — all 1554
products — so any product can be typed in whether or not it scored; the runners-up sit under
it as one-click chips, and **Keep the sheet name** rejects the lot. A name that is not a real
catalogue product is refused out loud rather than silently kept, and the row falls back to the
sheet's own name. A choice that crosses the company the sheet named stays possible — the
person at the desk may know something the sheet does not say — but it is never quiet: the row
warns, naming both companies. **Accept every suggestion** and **Keep all sheet names** settle
the whole sheet at once; the first asks first when some of the rows did not clear the
automatic check, and marks what it sets as **Chosen by you** rather than as a match the tool
stands behind. A product the catalogue does not have imports under the sheet's own name with
no salt and no photo, which is what the old behaviour did for everything.

Nothing is decided permanently: reopen the dialog from the button next to Import, change any
row, and the preview follows.

A product matched to the catalogue is published under the catalogue's name, so a row imported
earlier under the sheet's own name is **renamed in place before the import runs**, by id.
Skipping that would break the record in two ways at once: `import_key` is generated from the
row, so a changed name no longer collides and the upsert inserts a second product while the
first stays listed under the old name; and "keep sold items sold" stops recognising the row,
putting hand-marked stock back on the public site. Renaming by id also means the row keeps its
identity, so saved shortlists and shared links survive it.

## Importing stock

1. Drop the current `.xlsx`/`.xls`/`.csv`/`.tsv` on step 1. The first worksheet is read. Its
   first thirty rows are scanned for the row that really names product, expiry and quantity,
   so a company banner, a blank line or a "NEAR EXPIRY STOCK STATEMENT" title above the
   header does not become the header. Where that row is is reported beside the file name.
2. Columns are auto-detected; correct them in step 2 if the sheet uses unusual headers.
3. Step 3 parses every row before anything is sent, and reports how many are ready, how many
   duplicates were merged and how many will be skipped. Rows whose expiry cannot be read are
   highlighted with the reason, so they can be corrected in the sheet.
4. Sheets are read as UTF-8, so Gujarati and Hindi product names and the `₹` sign survive
   the import intact.
5. Expiry accepts `11/26`, `06.27`, `Nov-26`, `JAN26`, `September 2027`, `2026-11`,
   `01-Nov-2026` and genuine Excel date cells. Anything ambiguous — `26/11`, `13/26`, `n/a` —
   is rejected rather than guessed at, so a wrong expiry is never published.
6. Quantity 0 is imported as sold. A quantity that is blank, not a number or negative is
   **not**: those rows are skipped and named, because zero means sold and quietly reading
   "n/a" as sold takes real stock off the public site. A decimal quantity is rounded down and
   says so. "Keep sold items sold when the sheet is unchanged" leaves a hand-marked sold row
   alone when its sheet quantity has not moved, so a stale sheet line cannot put phantom
   stock back on the public site.
7. Two lines for the same product, batch and expiry are one delivery listed twice, so their
   quantities are **added**. Keeping only the last is how a sheet listing 40 and then 60
   imports as 60 and the other 40 quietly stops existing.

## Deleting

**Delete** on a row goes immediately, with no confirmation: the row leaves the table on the
click and the database catches up behind it. Sold-out stock is cleared in runs, and a
confirmation plus a reload between each one made that a chore. The row disappearing is the
receipt, so there is no success message either — only a refusal speaks up, and it puts the
row back exactly where it was and says why. The photo is removed after the row, so a
database refusal cannot destroy a photo under a product that is still listed.

Nothing here can be undone, so be deliberate with it.

### Checking the public catalogue

The catalogue and the admin share an origin, so they share the stored Supabase session. Once
someone signs in to the admin, the public page **in that same browser** reads as that account
rather than as a visitor — so every permission a visitor lacks looks fine to the one person
most likely to be checking, and the fault only shows up on somebody else's machine.

The catalogue therefore uses its own client that never picks a session up. What staff see
there is what a chemist sees, in the same browser, signed in or not. When a column has to be
given up the console says which and why, rather than the page just quietly going without it.

### "permission denied for table near_expiry_items"

Postgres error `42501`, and always a grant rather than a policy: row-level security that
refuses a read returns no rows, never this. The public catalogue reads as `anon`, so that role
needs select on the table:

```sql
grant select on public.near_expiry_items to anon, authenticated;
```

What the table currently gives out:

```sql
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'near_expiry_items';
```

A project that grants column by column rather than table-wide does not extend those grants to
a column added later, so `price` or `company` can be refused while everything else is
readable. That case degrades — the column is dropped from the query and the catalogue loads
without it — but the fix is to grant it:

```sql
grant select (price, company) on public.near_expiry_items to anon, authenticated;
```

A denial covering the whole table is fatal and says so on the page, because there is nothing
left to show.

### Photos left behind in storage

`storage.remove()` refuses the same way the table delete does: it answers with the objects it
actually removed, and a bucket policy that declines simply returns an empty list with no
error. Checking only the error therefore left the file in the bucket while the page reported
success — invisible in the admin, still counting against storage, which is how photos pile up
under a folder named after the account that uploaded them.

Every removal is now checked against what came back, and whatever stayed is named in the
message. **Photo inbox → Find unused photos** walks the bucket, subtracts every `photo_path`
the table holds, and offers to delete the difference — both the ones already stranded and
anything a future refusal leaves. Deleting from there asks first, since it acts on a list
rather than a row.

A bulk delete that the database only partly allows now removes the photos of the products it
did delete, rather than orphaning all of them.

If photos will not delete, the bucket needs a delete policy for signed-in users on
`storage.objects`:

```sql
create policy "Signed-in staff can delete photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'near-expiry-photos');
```

A policy scoped to `owner = auth.uid()` instead means each account can only remove what it
uploaded, so one person's photos survive another's delete — worth checking if the bucket has
files under more than one folder.

### If Delete does nothing

A row-level security policy that declines a delete is **not** an error in PostgREST: the
statement matches no rows and the request comes back `204 No Content` with nothing to
complain about. So a delete the database refuses looks exactly like one it performed, unless
the page asks for the deleted rows back and checks that any arrived — which every write here
now does. If nothing came back, the page says so and puts the row back rather than showing a
table that disagrees with the database.

Seeing that message means `near_expiry_items` has no policy letting signed-in users delete.
Check what it does have:

```sql
select policyname, cmd, roles, qual
from pg_policies
where schemaname = 'public' and tablename = 'near_expiry_items';
```

A table with RLS enabled and no `DELETE` policy refuses every delete, silently. Add one:

```sql
grant delete on public.near_expiry_items to authenticated;

create policy "Signed-in staff can delete"
  on public.near_expiry_items
  for delete
  to authenticated
  using (true);
```

Editing needs the matching `UPDATE` policy, and the status toggle and photo upload report the
same way if it is missing:

```sql
grant update on public.near_expiry_items to authenticated;

create policy "Signed-in staff can update"
  on public.near_expiry_items
  for update
  to authenticated
  using (true) with check (true);
```

`using (true)` lets any signed-in account delete. To restrict it to certain staff, put the
condition there instead — for example `using (exists (select 1 from public.profiles p where
p.id = auth.uid() and p.role = 'admin'))`.

Missing the table `grant` rather than the policy is the other half of this: that one Postgres
*does* raise, as `42501`, and the page reports it as an account permission problem.

**Delete all** clears exactly what the table is showing — not the whole catalogue sitting
behind a filter. Filter to *Sold only* and it deletes the sold stock; clear the filters and
it deletes everything. The button counts what it would take ("Delete all 47 shown"), and the
confirmation names that count, the filter it came from, and how many carry a photo. This one
does confirm, because it is the single click that cannot be walked back. Large runs go in
batches of 100 with progress on screen; if one batch fails partway, the table reloads to show
what actually survived rather than guessing.

Every signed-in user sees both. Anyone who can reach the admin page can already edit any
field and re-import the whole catalogue, so hiding only this one button was not a real
control. If delete should be restricted to certain staff, do it with a row-level security
policy on `near_expiry_items` — the page reports a refusal from the database in plain words
rather than failing silently.

The inventory table carries a shelf-life column, and **Expired, still listed** counts stock
that is past its expiry month but still public. The status filter has a matching view so those
rows can be found and marked sold.

Photos are matched to products by filename in the photo inbox; confirm or correct each name
(or click a suggestion), then upload. Names typed by hand are preserved when more photos are
added.

## Company

Each product carries the company it comes from — shown above the product name on the public
catalogue, in its own column in the admin inventory, in the WhatsApp share text, and matched
by search, so `lupin` finds the Lupin stock.

The catalogue also has a company filter beside the expiry one. It is built from the stock
actually listed rather than from the master, so a company with nothing near expiry never
appears, and it hides itself entirely when fewer than two companies are on the page — which
includes the case where the migration has not been run.

Like price, the column is not created by anything in this repository. Add it once in
Supabase:

```sql
alter table public.near_expiry_items
  add column if not exists company text;
```

Until it exists both pages run exactly as before, with the company field, column and Excel
mapping hidden and a notice on the admin page; companies appear everywhere the moment the
migration is run, with no further change.

How that is worked out matters, because it used to be got wrong. The catalogue asks for every
column in one query and gives up only the one PostgREST names as missing; the admin reads the
answer off the rows it already fetched with `select("*")`. Neither sends a separate probe
whose failure could be mistaken for absence — a probe that answers "no such column" for a
dropped connection means one flaky request on a cold page load hides every price and company
while the products themselves load and look entirely normal. A request that fails for any
other reason now surfaces as the load error it is, with the reload the page already offers. If the project
uses column-level grants rather than table-level ones, grant `select` on the new column to
`anon` and `authenticated` as well.

Mostly it fills itself in. `product-master.json` already records the company for all 1554
catalogue products, so:

- typing a recognised product name in the admin form fills the company in, alongside the
  salt it already filled;
- an import looks the company up per row, so a sheet with no company column still lands with
  companies attached.

The importer also reads a company column named Company, Manufacturer, Mfr, Brand, Division
or Supplier when the sheet has one, and that takes precedence over the master. A re-import
from a sheet without the column never blanks a company already on a record.

The admin field offers the companies the master knows as a picklist, so one company cannot
drift into three spellings. It stays free text, for stock from a company not in the master.

## Prices

Price is optional and per pack, shown as `₹`. A product without one shows "On request" once
any product in the catalogue is priced, and nothing at all while none are — so the field can
be ignored entirely.

The column is not created by anything in this repository. Add it once in Supabase:

```sql
alter table public.near_expiry_items
  add column if not exists price numeric(10,2);
```

Until it exists both pages run exactly as before, with the price field, column and Excel
mapping hidden and a notice on the admin page; prices appear everywhere the moment the
migration is run, with no further change. This is worked out the same way company is, above. If the project uses
column-level grants rather than table-level ones, grant `select` on the new column to `anon`
and `authenticated` as well.

The importer reads a price column named Price, Rate, MRP, PTR or PTS, and accepts `125`,
`125.50`, `₹1,250`, `Rs. 90/-` and `1,04,500`. A price it cannot read is a warning, not a
reason to skip the product: the row imports without a price and is flagged in the preview.

## Contact

The WhatsApp number the public catalogue links to lives in `config.js` as `whatsappNumber`
(country code first, digits only). The Share button on a product opens WhatsApp's own contact
picker instead, so a viewer forwards the offer to whoever they choose.

## Photos

A product shows the first of these that exists:

1. **The photo uploaded here**, from Supabase Storage — what the photo inbox and the edit
   form write. This is always preferred: it is the actual batch in stock.
2. **The main site's photo**, from `../Photos/` — the pack shot `search.html` already uses.
   About 750 of the 1554 products in the master have one, so most of the catalogue shows a
   pack the day it is imported, before anyone photographs the batch.
3. Otherwise the "Photo pending" placeholder.

If an uploaded photo's URL fails — a `photo_path` outliving the object it names — the page
falls through to the website photo rather than leaving a broken frame.

The lookup runs off `photo-map.json`, which `tools/build-photo-map.py` generates from the
`PHOTO_MAP` in the main site's `data.js`. Regenerate it whenever `convert.py` rebuilds
`data.js`:

```sh
python3 tools/build-photo-map.py
```

Matching is by product name, on two keys. The first keeps bracketed pack text, so the 30 ml
and 60 ml bottles of a syrup keep their own photos; the second drops it, to catch a name
recorded slightly differently. A key that more than one photo answers to is left out of the
map entirely — several products differ only by pack size or flavour, and a placeholder beats
the wrong pack shot. Nine products sit in that category today.

Between regenerations the map can only go stale in the safe direction: an unrecognised name
falls to the placeholder, and a filename that has since been renamed fails its image load and
falls to the placeholder too. Neither breaks a page.

A cold browser fetches `photo-map.json` alongside everything else the page needs, so it is
retried before being given up on: swallowing one dropped request there took every website
photo off the page at once, which looks like the photos being broken in that browser rather
than like a single failed fetch. Giving up on it now says so in the console.

The admin inventory shows a borrowed photo dimmed with a dashed border, and **Missing photo**
still counts products with no upload of their own — a product wearing the website's pack shot
still wants a real photo of the batch in stock.

Nothing here writes into `Photos/`. Uploads go to Supabase; the folder is read-only to this
app.

## Data and hosting

- Website: GitHub Pages from the `main` branch root, at `shreenarayanitraders.com`.
- Database and authentication: Supabase Postgres + Auth.
- Original product photos: Supabase Storage bucket `near-expiry-photos`.
- Fallback product photos: `../Photos/`, shared with the main site.
- Product/salt reference: `product-master.json`, generated from the SNT master Excel.

The Supabase publishable key in `config.js` is safe for browser use because database writes are
protected by Auth, explicit grants and Row Level Security. Never place a service-role key in
this repository.

The database migration is maintained privately in Supabase and is intentionally not included in
this public website repository.

## Testing the matcher

The matcher decides which medicine a sheet line becomes, so it is tested rather than trusted.
Both modules are plain CommonJS-and-browser files with no dependencies, so there is nothing to
install:

```sh
node --test "near-expiry/tests/*.test.js"      # 51 acceptance tests
node near-expiry/tests/regression.mjs          # the report on the representative sheet
node near-expiry/tests/regression.mjs sheet.csv --detail   # or on a real one
```

The tests run against the real `product-master.json`, not a fixture: thresholds this
consequential are only worth anything against the catalogue they will actually meet, and a
master that drifts should fail here rather than in the admin. They cover the company gate
(including a product whose name is an exact catalogue name and whose only defence is its
manufacturer), the dose and dosage-form penalties, the ambiguity gate, normalisation, header
detection, quantity validation and duplicate merging, and they assert that the ranking does
not depend on the order the master happens to be in.

The regression runner exits non-zero on either non-negotiable — a suggestion that crosses a
company boundary, or a suggestion offered for a company the master does not carry — rather
than reporting it as a number to read past. On the representative sheet in `tests/`:

| Outcome | Rows | Product + company pairs |
|---|---:|---:|
| Safe automatic matches | 139 | 138 |
| Ambiguous names left for review | 24 | 24 |
| No safe match; sheet name retained | 22 | 22 |
| Cross-company suggestions | 0 | 0 |
| Unknown-company suggestions | 0 | 0 |

`tests/sample-near-expiry.csv` is generated by `tests/build-sample-sheet.py` from the master —
real distributor sheets are customer data and are not kept in a public repository. It is
deterministic, and it carries the things a real sheet has that a master does not: four rows of
preamble above the header, companies SNT does not stock, products the catalogue does not have,
flavour and pack names stripped of the word that told them apart, a repeated line, and
quantities that are blank, negative, decimal, zero and not a number.

Every threshold lives in `THRESHOLDS` at the top of `matching.js` and is asserted in the
tests. Lowering one to raise the automatic-match count trades a person's minute for the chance
of the wrong medicine on the public site; run the regression and say what the new number costs
before doing it.

## Deploying

GitHub Pages will happily hand a browser a cached `admin.js` while re-fetching the `admin.html`
that loads it, which deploys as new markup driving old code — the symptom being a new control
that renders empty because the cached script knows nothing about it. The script and stylesheet
links therefore carry a content hash. **After changing any JS or CSS here, restamp them before
committing:**

```sh
python3 tools/stamp-assets.py
```

Re-running it with nothing changed rewrites nothing.

## Source layout

- `matching.js` — the product matcher: normalisation, the company gate, weighted scoring and
  the automatic-selection thresholds. A pure module with no DOM, no Supabase and no network,
  so it runs in the browser and under `node --test` against the real master.
- `sheet.js` — the import safeguards that are not about product similarity: the header scan,
  column detection, quantity validation and duplicate merging. Pure for the same reason.
- `tests/` — the acceptance tests for both, the regression runner, and the representative
  sheet it reads. See **Testing the matcher** below.
- `shared.js` — Supabase client plus the shared helpers: expiry parsing and shelf-life
  calculation, token search, escaping and toasts.
- `catalog.js` / `admin.js` — the two pages' behaviour.
- `styles.css` — one design system for both pages.
- `photo-map.json` — generated; product name → filename in `../Photos/`.
- `../tools/build-photo-map.py` — regenerates that map from the main site's `data.js`.
- `../tools/stamp-assets.py` — re-hashes the script and stylesheet links after a JS or CSS change.

## Main dependencies

The static pages pin browser builds of:

- `@supabase/supabase-js` 2.112.4
- `xlsx` 0.18.5
- `fflate` 0.8.3

If a CDN is unreachable the pages now say so instead of sitting on a blank loading state.
