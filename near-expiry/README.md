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

## Importing stock

1. Drop the current `.xlsx`/`.xls`/`.csv`/`.tsv` on step 1. The first worksheet is read.
2. Columns are auto-detected; correct them in step 2 if the sheet uses unusual headers.
3. Step 3 parses every row before anything is sent, and reports how many are ready, how many
   duplicates were merged and how many will be skipped. Rows whose expiry cannot be read are
   highlighted with the reason, so they can be corrected in the sheet.
4. Sheets are read as UTF-8, so Gujarati and Hindi product names and the `₹` sign survive
   the import intact.
5. Expiry accepts `11/26`, `06.27`, `Nov-26`, `JAN26`, `September 2027`, `2026-11`,
   `01-Nov-2026` and genuine Excel date cells. Anything ambiguous — `26/11`, `13/26`, `n/a` —
   is rejected rather than guessed at, so a wrong expiry is never published.
6. Quantity 0 is imported as sold. "Keep sold items sold when the sheet is unchanged" leaves
   a hand-marked sold row alone when its sheet quantity has not moved, so a stale sheet line
   cannot put phantom stock back on the public site.

## Deleting

**Delete** on a row goes immediately, with no confirmation: the row leaves the table on the
click and the database catches up behind it. Sold-out stock is cleared in runs, and a
confirmation plus a reload between each one made that a chore. The row disappearing is the
receipt, so there is no success message either — only a refusal speaks up, and it puts the
row back exactly where it was and says why. The photo is removed after the row, so a
database refusal cannot destroy a photo under a product that is still listed.

Nothing here can be undone, so be deliberate with it.

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

Like price, the column is not created by anything in this repository. Add it once in
Supabase:

```sql
alter table public.near_expiry_items
  add column if not exists company text;
```

Both pages probe for it on load. Until it exists they run exactly as before, with the
company field, column and Excel mapping hidden and a notice on the admin page; companies
appear everywhere the moment the migration is run, with no further change. If the project
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

Both pages probe for the column on load. Until it exists they run exactly as before, with the
price field, column and Excel mapping hidden and a notice on the admin page; prices appear
everywhere the moment the migration is run, with no further change. If the project uses
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

## Source layout

- `shared.js` — Supabase client plus the shared helpers: expiry parsing and shelf-life
  calculation, token search, escaping and toasts.
- `catalog.js` / `admin.js` — the two pages' behaviour.
- `styles.css` — one design system for both pages.
- `photo-map.json` — generated; product name → filename in `../Photos/`.
- `../tools/build-photo-map.py` — regenerates that map from the main site's `data.js`.

## Main dependencies

The static pages pin browser builds of:

- `@supabase/supabase-js` 2.112.4
- `xlsx` 0.18.5
- `fflate` 0.8.3

If a CDN is unreachable the pages now say so instead of sitting on a blank loading state.
