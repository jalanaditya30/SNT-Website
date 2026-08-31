(function () {
  "use strict";

  const config = window.SNT_CONFIG;
  const missing = !config ? "config.js" : !window.supabase ? "the Supabase library" : "";
  if (missing) {
    document.addEventListener("DOMContentLoaded", () => {
      const banner = document.createElement("div");
      banner.className = "boot-error";
      banner.innerHTML = `<strong>This page could not start.</strong><span>${missing} did not load — usually a slow or blocked internet connection. Please check the connection and reload.</span><button type="button" onclick="location.reload()">Reload</button>`;
      document.body.prepend(banner);
      document.querySelectorAll(".catalog-status, .loading-overlay").forEach((node) => node.remove());
    });
    return;
  }

  const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  /* The catalogue and the admin share an origin, so they share the stored session: once
     somebody signs in to the admin, the public page in that same browser starts reading as
     that account instead of as a visitor. Every permission a visitor lacks then looks fine to
     the one person most likely to check. The catalogue therefore gets its own client that
     never picks a session up, so what staff see there is exactly what a chemist sees. */
  const publicClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "snt-near-expiry-anon" }
  });

  const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MIN_YEAR = new Date().getFullYear() - 6;
  const MAX_YEAR = new Date().getFullYear() + 20;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  function normalise(value) {
    return String(value ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  }

  /* Search keeps pack sizes and punctuation-separated words so "pan 40" and "10's" stay findable. */
  function searchable(value) {
    return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function queryTokens(query) {
    return searchable(query).split(" ").filter(Boolean);
  }

  function matchesTokens(haystack, tokens) {
    if (!tokens.length) return true;
    const target = searchable(haystack);
    return tokens.every((token) => target.includes(token));
  }

  /* Higher is better: exact name, then name prefix, then how early each token lands. */
  function relevance(product, tokens) {
    if (!tokens.length) return 0;
    const name = searchable(product.product_name);
    const joined = tokens.join(" ");
    let score = 0;
    if (name === joined) score += 1000;
    if (name.startsWith(joined)) score += 500;
    tokens.forEach((token) => {
      const position = name.indexOf(token);
      if (position === 0) score += 60;
      else if (position > 0) score += 30;
      else if (searchable(product.salt_name).includes(token)) score += 10;
    });
    return score;
  }

  function buildExpiry(year, month) {
    if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
    if (month < 1 || month > 12 || year < MIN_YEAR || year > MAX_YEAR) return null;
    return `${year}-${String(month).padStart(2, "0")}-01`;
  }

  function expandYear(value) {
    const year = Number(value);
    if (!Number.isFinite(year)) return NaN;
    return String(value).trim().length <= 2 ? 2000 + year : year;
  }

  function monthFromName(name) {
    const index = MONTH_KEYS.indexOf(String(name).slice(0, 3).toLowerCase());
    return index < 0 ? null : index + 1;
  }

  /* One validated path for every expiry the app accepts. Returns YYYY-MM-01 or null —
     never an out-of-range month or a year guessed by the Date constructor. */
  function parseExpiry(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return buildExpiry(value.getFullYear(), value.getMonth() + 1);
    const text = String(value ?? "").trim();
    if (!text) return null;
    let match = text.match(/^(\d{4})[-/.\s](\d{1,2})$/);
    if (match) return buildExpiry(Number(match[1]), Number(match[2]));
    match = text.match(/^(\d{1,2})[-/.\s](\d{2}|\d{4})$/);
    if (match) return buildExpiry(expandYear(match[2]), Number(match[1]));
    match = text.match(/^([A-Za-z]{3,9})[-/.\s]*(\d{2}|\d{4})$/);
    if (match) return buildExpiry(expandYear(match[2]), monthFromName(match[1]));
    match = text.match(/^(\d{1,2})[-/.\s]([A-Za-z]{3,9})[-/.\s](\d{2}|\d{4})$/);
    if (match) return buildExpiry(expandYear(match[3]), monthFromName(match[2]));
    match = text.match(/^(\d{4})(\d{2})$/);
    if (match) return buildExpiry(Number(match[1]), Number(match[2]));
    return null;
  }

  /* An expiry is a calendar month, not an instant. Formatting it through `new Date("YYYY-MM-DD")`
     reads the string as local midnight and then renders it in UTC, which shows every date one
     month early for anyone east of UTC — the whole of India. Format from the digits instead. */
  function expiryParts(value) {
    const match = String(value ?? "").match(/^(\d{4})-(\d{2})/);
    if (!match) return null;
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
  }

  function formatExpiry(value) {
    const parts = expiryParts(value);
    if (!parts) return value ? String(value) : "—";
    return `${MONTH_LABELS[parts.month - 1]}/${String(parts.year).slice(-2)}`;
  }

  function expiryForInput(value) {
    return value ? String(value).slice(0, 7) : "";
  }

  function monthToDate(value) {
    return parseExpiry(value);
  }

  /* Whole months from this month to the expiry month, plus a shelf-life tone for the UI.
     Stock is saleable through the end of its expiry month, so the current month counts as 0. */
  function expiryMeta(value) {
    const parts = expiryParts(value);
    if (!parts) return { months: null, tone: "unknown", label: "No expiry" };
    const today = new Date();
    const months = (parts.year - today.getFullYear()) * 12 + (parts.month - (today.getMonth() + 1));
    if (months < 0) return { months, tone: "expired", label: "Expired" };
    if (months === 0) return { months, tone: "critical", label: "This month" };
    if (months <= 3) return { months, tone: "critical", label: `${months} mo left` };
    if (months <= 6) return { months, tone: "soon", label: `${months} mo left` };
    if (months < 12) return { months, tone: "ok", label: `${months} mo left` };
    return { months, tone: "ok", label: `${Math.floor(months / 12)} yr+` };
  }

  /* Prices are entered per pack in rupees. Whole rupees lose the decimals so a
     catalogue of round numbers stays easy to scan. */
  function formatPrice(value) {
    if (value === null || value === undefined || value === "") return "";
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    return `${config.currency || "₹"}${number.toLocaleString("en-IN", {
      minimumFractionDigits: Number.isInteger(number) ? 0 : 2, maximumFractionDigits: 2
    })}`;
  }

  /* Accepts what a stock sheet actually contains: 125, "125.50", "₹1,250", "Rs. 90/-". */
  function parsePrice(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/rs\.?/gi, "").replace(/[₹,\s]/g, "").replace(/\/-$/, "").trim();
    if (!text) return null;
    const number = Number(text);
    if (!Number.isFinite(number) || number < 0) return null;
    return Math.round(number * 100) / 100;
  }

  /* The price column is added by a migration this repository does not ship. Probe for it once
     so both pages keep working — without prices — until that migration has been run. */
  /* Price and company each live behind a migration this repository does not ship, so what the
     database actually has has to be discovered rather than assumed.

     Asking and adapting, not probing. A probe answered "no such column" for every kind of
     failure, so a single dropped request on a cold connection — a TLS handshake, a token
     refresh, one rate-limited call — hid every price and company on the page while the
     products themselves loaded a moment later and looked perfectly normal. PostgREST names
     the column it does not have, so the query drops that one and runs again; anything else is
     a real failure and is thrown, where the page already reports it and offers a reload.
     Wrong data is never quietly preferred to an error. */
  async function selectWithOptional(build, optional, reader = client) {
    let columns = [...optional];
    let retries = 2;
    for (;;) {
      const { data, error } = await build(columns);
      if (!error) return { data, present: columns };

      /* The column is not there. PostgREST names it, so drop that one and ask again. */
      if (error.code === "42703") {
        const missing = columns.find((column) => new RegExp(`\\b${column}\\b`).test(error.message || ""));
        if (missing) { columns = columns.filter((name) => name !== missing); continue; }
      }

      /* The column is there but this role may not read it — a project granting select
         column by column does not extend that to a column added later. The message names
         only the table, so each optional column is tried on its own to find which. If none
         of them is the problem the denial is on the table itself, and that is fatal. */
      if (error.code === "42501" && columns.length) {
        const readable = [];
        for (const column of columns) {
          /* Asked as whoever is running the query, so the catalogue tests what a visitor may
             read rather than what the signed-in admin may. */
          const { error: denied } = await reader.from("near_expiry_items").select(column).limit(1);
          if (!denied) readable.push(column);
        }
        if (readable.length < columns.length) {
          /* Said out loud: a column silently dropped is exactly how "no prices on this page"
             looks like a caching problem for a day. */
          console.warn(`[SNT] Dropped ${columns.filter((c) => !readable.includes(c)).join(" and ")} — this role may not read them. `
            + "Run: grant select (price, company) on public.near_expiry_items to anon, authenticated;");
          columns = readable;
          continue;
        }
      }

      /* Anything else is the request failing, not the schema. One dropped call must never
         be read as a missing column - that hid every price on the page - so the same query
         is tried again before the failure is believed and reported. */
      if (retries > 0) {
        retries -= 1;
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      throw error;
    }
  }

  /* Only for a table with no rows to learn from. Absent means PostgREST said so; every other
     failure is thrown rather than read as absence. */
  async function columnExists(column) {
    const { error } = await client.from("near_expiry_items").select(column).limit(1);
    if (!error) return true;
    if (error.code === "42703") return false;
    throw error;
  }

  function whatsappLink(text) {
    const number = String(config.whatsappNumber || "").replace(/\D/g, "");
    const query = text ? `?text=${encodeURIComponent(text)}` : "";
    return number ? `https://wa.me/${number}${query}` : `https://wa.me/${query}`;
  }

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString("en-IN") : "0";
  }

  function photoUrl(path) {
    if (!path) return "";
    return client.storage.from(config.photoBucket).getPublicUrl(path).data.publicUrl;
  }

  /* ---- website photo fallback --------------------------------------------
     The main site already carries a pack shot for most of the catalogue in
     /Photos, indexed by product name in photo-map.json. A near-expiry row with no
     photo of its own borrows that one, so a product listed before anyone has
     photographed the batch still shows the pack rather than a placeholder. Stock
     photos are only ever read: uploads from the admin page go to Supabase, and
     nothing here writes into the repository. */

  const photoTable = { files: [], exact: {}, loose: {} };

  /* Must stay in step with exact_key() in tools/build-photo-map.py: slashes become
     the hyphen the photos were saved with, the rest of what a filename cannot hold
     is dropped, and runs of whitespace collapse. Bracketed pack text stays, so the
     30 ml and 60 ml bottles of a syrup keep their own photos. */
  function photoKey(name) {
    return String(name ?? "").toLowerCase().replace(/[/\\]/g, "-").replace(/[:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  }

  function websitePhoto(name) {
    const at = photoTable.exact[photoKey(name)] ?? photoTable.loose[normalise(name)];
    const file = at === undefined ? "" : photoTable.files[at];
    /* Every filename has spaces, and some carry &, + or a % - encode the segment
       itself and leave the folder separator alone. */
    return file ? `${config.websitePhotos}${encodeURIComponent(file)}` : "";
  }

  /* Supabase first, the website photo second - the order the catalogue promises. */
  function productPhoto(product) {
    return photoUrl(product?.photo_path) || websitePhoto(product?.product_name);
  }

  /* Read once, in parallel with the product load. A missing or broken map is not
     an error worth stopping a page for: the fallback simply never fires and every
     product falls back to its placeholder, exactly as before this existed. */
  /* A cold browser fetches this alongside everything else the page needs, and swallowing a
     failure here means every website photo quietly disappears while the products load — which
     reads as "the photos are broken in this browser" rather than as one dropped request. So it
     is tried again before being given up on, and giving up says so. */
  const photoTableReady = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(config.websitePhotoMap, { cache: "force-cache" });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const table = await response.json();
        if (!table || !Array.isArray(table.files)) throw new Error("the photo map is not in the expected shape");
        photoTable.files = table.files;
        photoTable.exact = table.exact || {};
        photoTable.loose = table.loose || {};
        return true;
      } catch (error) {
        if (attempt === 2) {
          console.warn(`[SNT] ${config.websitePhotoMap} could not be read (${error.message}); products will fall back to their placeholder rather than the website photo.`);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    return false;
  })();

  function initials(name) {
    return String(name || "SNT").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function toast(message, kind = "success") {
    let region = document.querySelector(".toast-region");
    if (!region) {
      region = document.createElement("div");
      region.className = "toast-region";
      region.setAttribute("aria-live", "polite");
      document.body.append(region);
    }
    const item = document.createElement("div");
    item.className = `toast toast--${kind}`;
    item.textContent = message;
    region.append(item);
    setTimeout(() => { item.classList.add("is-leaving"); setTimeout(() => item.remove(), 220); }, 4200);
  }

  window.SNT = {
    client, publicClient, config, escapeHtml, normalise, searchable, queryTokens, matchesTokens, relevance,
    parseExpiry, formatExpiry, expiryParts, expiryForInput, monthToDate, expiryMeta, formatNumber,
    formatPrice, parsePrice, selectWithOptional, columnExists, whatsappLink, photoUrl, websitePhoto, productPhoto,
    photoTableReady, initials, toast
  };
})();
