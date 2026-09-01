(function () {
  "use strict";

  if (!window.SNT) return;
  /* matching.js and sheet.js are this app's own files rather than a CDN's, so a miss here is
     a deploy problem, not a network one — but the importer is built entirely on them, and a
     page that silently imported without the company gate would be worse than one that says
     it cannot import. */
  if (!window.SNTMatching || !window.SNTSheet) {
    console.error("[SNT] matching.js or sheet.js did not load; the importer is disabled.");
    window.SNT.toast("The matching module did not load — reload this page before importing.", "error");
    return;
  }
  const { client, config, escapeHtml, normalise, searchable, queryTokens, matchesTokens, parseExpiry, formatExpiry,
    expiryForInput, expiryMeta, formatNumber, formatPrice, parsePrice, columnExists, photoUrl,
    websitePhoto, photoTableReady, toast } = window.SNT;

  const CHUNK = 100;
  const PREVIEW_ROWS = 60;
  const state = {
    user: null, role: "operator", products: [], master: [],
    workbookRows: [], rawRows: [], headers: [], parsed: [], editing: null, photos: [], hasPrice: false, hasCompany: false,
    /* ids whose delete is still in flight, so a double-click cannot fire two */
    removing: new Set(), deletingAll: null, orphans: [],
    /* Keyed by normalised sheet product + sheet company, because the same brand under two
       companies is two separate questions.
         suggestions - what the matcher offered, and its verdict
         matches     - the master product settled on ("" = keep the sheet name)
         decided     - keys a person has actually answered, so an unanswered row keeps
                       reading as "check it" rather than as a deliberate rejection */
    matches: new Map(), suggestions: new Map(), matchNotes: new Map(), decided: new Set(),
    matchIndex: null, headerRow: 0
  };
  const element = (selector) => document.querySelector(selector);
  const elements = {
    loginView: element("#loginView"), adminView: element("#adminView"), loading: element("#loadingOverlay"),
    rows: element("#inventoryRows"), search: element("#adminSearch"), statusFilter: element("#adminStatusFilter"),
    formDialog: element("#productFormDialog"), deleteAllDialog: element("#deleteAllDialog"), matchDialog: element("#matchDialog"), photoInbox: element("#photoInbox")
  };

  function setLoading(active, message = "Working…") {
    elements.loading.querySelector("span").textContent = message;
    elements.loading.classList.toggle("hidden", !active);
  }

  /* The importer and the ZIP reader come from CDNs; say so plainly instead of throwing ReferenceError. */
  function requireLibrary(name, global) {
    if (window[global]) return true;
    toast(`${name} did not load — check the internet connection and reload this page.`, "error");
    return false;
  }

  async function currentIdentity() {
    const { data, error } = await client.auth.getUser();
    if (error && error.name !== "AuthSessionMissingError") throw error;
    if (!data.user) return null;
    const { data: profile, error: profileError } = await client.from("profiles").select("display_name,role").eq("id", data.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile) {
      await client.auth.signOut();
      throw new Error("This account has no admin profile yet. Ask an SNT admin to add it in Supabase.");
    }
    state.user = data.user;
    state.role = profile.role;
    element("#adminUser").textContent = `${profile.display_name || data.user.email} · ${profile.role}`;
    return data.user;
  }

  /* Price and company each live behind a migration this repository does not ship, so each
     feature is switched on only once its column is really there.

     The inventory is read with select("*"), so a row that came back settles the question
     exactly and for free — no extra request to go wrong. Probing is left for a table with no
     rows to learn from, and there absence means PostgREST said so; a probe that fails any
     other way is thrown rather than read as "the column is missing", which is how a single
     dropped request used to hide every price on the page. */
  function applyOptionalColumns(sample) {
    if (sample) {
      state.hasPrice = "price" in sample;
      state.hasCompany = "company" in sample;
    }
    [["price", state.hasPrice], ["company", state.hasCompany]].forEach(([name, present]) => {
      document.querySelectorAll(`[data-${name}-column]`).forEach((node) => node.classList.toggle("hidden", !present));
      element(`#${name}Notice`).classList.toggle("hidden", present);
    });
  }

  /* Columns the inventory table is currently showing, for an empty row to span. */
  function tableColumns() {
    return 7 + (state.hasPrice ? 1 : 0) + (state.hasCompany ? 1 : 0);
  }

  async function showAuthenticated() {
    elements.loginView.classList.add("hidden");
    elements.adminView.classList.remove("hidden");
    element("#signOutButton").classList.remove("hidden");
    await Promise.all([loadProducts(), loadMaster()]);
  }

  /* Signing out must leave nothing on screen or in memory for the next person at the counter. */
  function showLogin() {
    state.user = null;
    state.role = "operator";
    state.products = [];
    state.workbookRows = [];
    state.rawRows = [];
    state.headers = [];
    state.parsed = [];
    state.editing = null;
    state.removing.clear();
    state.deletingAll = null;
    state.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
    state.photos = [];
    elements.rows.innerHTML = "";
    elements.photoInbox.innerHTML = "";
    element("#inventoryMeta").textContent = "";
    element("#previewRows").innerHTML = "";
    element("#validationSummary").innerHTML = "";
    element("#previewWrap").classList.add("hidden");
    element("#excelFile").value = "";
    element("#productPrice").value = "";
    element("#photoFiles").value = "";
    element("#excelFileStatus").textContent = "Drop an Excel or CSV file";
    element("#importPreview").textContent = "Select a file to preview its rows.";
    element("#importButton").disabled = true;
    element("#importButton").textContent = "Import products";
    ["#mapProduct", "#mapSalt", "#mapExpiry", "#mapQuantity", "#mapBatch", "#mapPrice", "#mapCompany"].forEach((id) => { element(id).innerHTML = ""; });
    element("#photoTabCount").textContent = "";
    element("#inventoryProductNames").innerHTML = "";
    element("#companyNames").innerHTML = "";
    ["#statTotal", "#statAvailable", "#statSold", "#statPhotos", "#statExpired"].forEach((id) => { element(id).textContent = "0"; });
    element("#loginPassword").value = "";
    elements.search.value = "";
    if (elements.formDialog.open) elements.formDialog.close();
    if (elements.deleteAllDialog.open) elements.deleteAllDialog.close();
    if (elements.matchDialog.open) elements.matchDialog.close();
    elements.loginView.classList.remove("hidden");
    elements.adminView.classList.add("hidden");
    element("#signOutButton").classList.add("hidden");
    element("#adminUser").textContent = "";
  }

  async function loadProducts() {
    const { data, error } = await client.from("near_expiry_items").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
    await photoTableReady;
    state.products = data || [];
    /* An empty table teaches nothing, so ask directly — the one case where a probe is right. */
    if (!state.products.length) {
      [state.hasPrice, state.hasCompany] = await Promise.all([columnExists("price"), columnExists("company")]);
    }
    applyOptionalColumns(state.products[0]);
    renderInventory();
    element("#inventoryProductNames").innerHTML = state.products.map((item) => `<option value="${escapeHtml(item.product_name)}"></option>`).join("");
  }

  async function loadMaster() {
    if (state.master.length) return;
    const response = await fetch("product-master.json");
    if (!response.ok) throw new Error("Product master could not load.");
    state.master = await response.json();
    element("#productMasterNames").innerHTML = state.master.map((item) => `<option value="${escapeHtml(item.name)}"></option>`).join("");
    /* The handful of companies the master actually carries, so the field is a pick rather
       than free text and "Alkem - Maxxio" cannot become three different spellings. */
    const companies = [...new Set(state.master.map((item) => item.company).filter(Boolean))].sort();
    element("#companyNames").innerHTML = companies.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
    buildMatchIndex();
  }

  function filteredProducts() {
    const tokens = queryTokens(elements.search.value);
    const filter = elements.statusFilter.value;
    return state.products.filter((item) => {
      if (filter === "nophoto" && item.photo_path) return false;
      if (filter === "expired" && !isExpiredAndListed(item)) return false;
      if ((filter === "available" || filter === "sold") && item.status !== filter) return false;
      return matchesTokens(`${item.product_name} ${item.salt_name || ""} ${item.batch_no || ""} ${item.company || ""}`, tokens);
    });
  }

  /* Stock that is past its expiry month but still on sale to the public. */
  function isExpiredAndListed(item) {
    return item.status === "available" && expiryMeta(item.expiry_date).tone === "expired";
  }

  /* "Missing photo" counts what has no uploaded photo of its own, not what the
     public sees - a product wearing the website's photo still wants a real batch
     shot. The borrowed one is shown but marked, so the two are never confused. */
  function photoCell(item) {
    if (item.photo_path) return `<img class="table-photo" src="${escapeHtml(photoUrl(item.photo_path))}" alt="" loading="lazy">`;
    const borrowed = websitePhoto(item.product_name);
    if (borrowed) return `<img class="table-photo table-photo--borrowed" src="${escapeHtml(borrowed)}" alt="" loading="lazy" title="From the website photo folder — no photo uploaded for this batch">`;
    return '<span class="table-photo table-photo--none">none</span>';
  }

  function renderInventory() {
    const counts = {
      total: state.products.length,
      available: state.products.filter((item) => item.status === "available").length,
      sold: state.products.filter((item) => item.status === "sold").length,
      photos: state.products.filter((item) => !item.photo_path).length,
      expired: state.products.filter(isExpiredAndListed).length
    };
    element("#statTotal").textContent = formatNumber(counts.total);
    element("#statAvailable").textContent = formatNumber(counts.available);
    element("#statSold").textContent = formatNumber(counts.sold);
    element("#statPhotos").textContent = formatNumber(counts.photos);
    element("#statExpired").textContent = formatNumber(counts.expired);
    element("#statExpired").closest(".stat-card").classList.toggle("stat-card--danger", counts.expired > 0);

    const products = filteredProducts();
    element("#inventoryMeta").textContent = products.length === state.products.length
      ? `${formatNumber(products.length)} products`
      : `${formatNumber(products.length)} of ${formatNumber(state.products.length)} products shown`;

    /* The label counts what the button would actually take, so a filtered table never
       reads as if it were about to clear the catalogue. */
    const deleteAll = element("#deleteAllButton");
    deleteAll.disabled = !products.length;
    deleteAll.textContent = products.length && products.length !== state.products.length
      ? `Delete all ${formatNumber(products.length)} shown`
      : "Delete all";

    elements.rows.innerHTML = products.length ? products.map((item) => {
      const shelf = expiryMeta(item.expiry_date);
      return `<tr data-row-id="${escapeHtml(item.id)}">
        <td>${photoCell(item)}</td>
        <td><strong>${escapeHtml(item.product_name)}</strong><small>${escapeHtml(item.salt_name || "No composition")}${item.batch_no ? ` · Batch ${escapeHtml(item.batch_no)}` : ""}</small></td>
        <td class="cell-company${state.hasCompany ? "" : " hidden"}" data-company-column>${escapeHtml(item.company) || "—"}</td>
        <td class="cell-exp">${formatExpiry(item.expiry_date)}</td>
        <td><span class="shelf shelf--${shelf.tone}">${escapeHtml(shelf.label)}</span></td>
        <td class="cell-num">${formatNumber(item.quantity)}</td>
        <td class="cell-price${state.hasPrice ? "" : " hidden"}" data-price-column>${escapeHtml(formatPrice(item.price)) || "—"}</td>
        <td><button class="mini-badge ${escapeHtml(item.status)}" type="button" data-toggle-status="${escapeHtml(item.id)}" title="Change status">${escapeHtml(item.status)}</button></td>
        <td><div class="row-actions"><button class="icon-button" type="button" data-edit="${escapeHtml(item.id)}">Edit</button><button class="icon-button danger" type="button" data-delete="${escapeHtml(item.id)}">Delete</button></div></td>
      </tr>`;
    }).join("") : `<tr><td class="table-empty" colspan="${tableColumns()}">No products match this search.</td></tr>`;
  }

  /* ---- matching a sheet name to the SNT catalogue --------------------------
     The scoring itself lives in matching.js, which knows nothing about this page: it is a
     pure module so it can be run under `node --test` against the real master, which is the
     only way thresholds this consequential are arguable rather than folklore. See
     near-expiry/tests/matching.test.js.

     What is left here is the plumbing - which pairs to ask about, what the operator is shown,
     and what a decision does to the preview. */

  function buildMatchIndex() {
    state.matchIndex = window.SNTMatching ? window.SNTMatching.buildIndex(state.master) : null;
  }

  /* A decision belongs to a product AND the company the sheet put beside it, not to the
     product name alone: the same brand under two companies is two different questions, and
     answering one must not answer the other.

     The key is written into the markup as an attribute and read back with CSS.escape, so it
     has to be printable: CSS.escape turns a NUL into U+FFFD, which then matches nothing and
     leaves the row it was meant to repaint showing its old verdict. "#" cannot occur in
     either half - normalisation leaves only [a-z0-9.] in the name, and a company key is
     letters, spaces and one slash. */
  const KEY_SEPARATOR = "#";

  function matchKey(name, company) {
    const M = window.SNTMatching;
    return `${M.normalizeName(name).compact}${KEY_SEPARATOR}${M.companyKey(M.normalizeCompany(company))}`;
  }

  /* The company the sheet actually names on this row. A literal "-BLANK-" means the column
     said nothing, not that the company is called that; what counts as nothing is decided in
     matching.js, so the gate and the importer cannot disagree about it. */
  function sheetCompanyOf(row, mapping) {
    const raw = mapping.company ? String(row[mapping.company] ?? "").trim() : "";
    return window.SNTMatching.normalizeCompany(raw).supplied ? raw : "";
  }

  function masterByName(name) {
    return state.master.find((item) => item.name === name) || null;
  }

  function masterMatch(name) {
    const key = normalise(name);
    return state.master.find((item) => normalise(item.name) === key);
  }

  function resetProductForm(product = null) {
    if (product === undefined) return;
    state.editing = product;
    element("#productFormTitle").textContent = product ? "Edit product" : "Add product";
    element("#productName").value = product?.product_name || "";
    element("#saltName").value = product?.salt_name || "";
    element("#productCompany").value = product?.company || "";
    element("#expiryMonth").value = expiryForInput(product?.expiry_date);
    element("#productQuantity").value = product?.quantity ?? 0;
    element("#productPrice").value = product?.price ?? "";
    element("#batchNumber").value = product?.batch_no || "";
    element("#productStatus").value = product?.status || "available";
    element("#productPhoto").value = "";
    updateFormNote();
    elements.formDialog.showModal();
  }

  /* Quantity 0 on an "available" item is the classic way a sold-out row stays on the public site. */
  function updateFormNote() {
    const quantity = Number(element("#productQuantity").value);
    const available = element("#productStatus").value === "available";
    element("#productFormNote").textContent = available && quantity <= 0
      ? "Quantity is 0 but the status is Available — buyers will see it as in stock."
      : "";
  }

  function closeProductForm() { if (elements.formDialog.open) elements.formDialog.close(); state.editing = null; }

  async function uploadPhoto(product, file) {
    const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${state.user.id}/${crypto.randomUUID()}.${extension || "jpg"}`;
    const { error: uploadError } = await client.storage.from(config.photoBucket).upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
    if (uploadError) throw uploadError;
    const { data: attached, error: updateError } = await client.from("near_expiry_items").update({ photo_path: path, updated_by: state.user.id }).eq("id", product.id).select("id");
    if (updateError || !attached?.length) {
      /* The row never took the path, so the file just uploaded belongs to nothing. */
      await client.storage.from(config.photoBucket).remove([path]);
      throw updateError || refused(NO_UPDATE_POLICY);
    }
    if (product.photo_path) await client.storage.from(config.photoBucket).remove([product.photo_path]);
    return path;
  }

  async function saveProduct(event) {
    event.preventDefault();
    const wasEditing = Boolean(state.editing);
    const expiry = parseExpiry(element("#expiryMonth").value);
    if (!expiry) return toast("Enter a valid expiry month.", "error");
    const quantity = Math.max(0, Math.trunc(Number(element("#productQuantity").value) || 0));
    const record = {
      product_name: element("#productName").value.trim(), salt_name: element("#saltName").value.trim(),
      batch_no: element("#batchNumber").value.trim() || null, expiry_date: expiry, quantity,
      status: element("#productStatus").value, updated_by: state.user.id, source: state.editing?.source || "manual"
    };
    if (!record.product_name) return toast("Product name is required.", "error");
    if (state.hasCompany) record.company = element("#productCompany").value.trim() || null;
    if (state.hasPrice) {
      const raw = element("#productPrice").value.trim();
      if (raw && parsePrice(raw) === null) return toast("Enter a valid price, or leave it blank.", "error");
      record.price = raw ? parsePrice(raw) : null;
    }
    setLoading(true, "Saving product…");
    try {
      let product;
      if (state.editing) {
        const { data, error } = await client.from("near_expiry_items").update(record).eq("id", state.editing.id).select().single();
        if (error) throw error; product = data;
      } else {
        const { data, error } = await client.from("near_expiry_items").insert({ ...record, created_by: state.user.id }).select().single();
        if (error) throw error; product = data;
      }
      const photo = element("#productPhoto").files[0];
      if (photo) await uploadPhoto(product, photo);
      closeProductForm(); await loadProducts(); toast(wasEditing ? "Product updated." : "Product added.");
    } catch (error) { toast(error.message || "Product could not be saved.", "error"); }
    finally { setLoading(false); }
  }

  async function toggleStatus(product) {
    if (!product) return;
    const status = product.status === "available" ? "sold" : "available";
    const { data: changed, error } = await client.from("near_expiry_items").update({ status, updated_by: state.user.id }).eq("id", product.id).select("id");
    if (error) return toast(error.message, "error");
    if (!changed?.length) return toast(NO_UPDATE_POLICY, "error");
    product.status = status; renderInventory(); toast(`Marked ${status}.`);
  }

  /* A row-level security policy that declines a delete or an update is not an error in
     PostgREST: the statement matches no rows and comes back 204 with nothing to complain
     about. Every write here therefore asks for the affected ids back, because "no rows came
     back" is the only signal that the database quietly kept the row - otherwise a blocked
     delete is indistinguishable from a successful one until the next refresh. */
  function refused(message) {
    const error = new Error(message);
    error.refused = true;
    return error;
  }

  const NO_DELETE_POLICY = "The database would not delete this — nothing was removed. "
    + "near_expiry_items has no row-level security policy allowing deletes for signed-in users. "
    + "An SNT admin needs to add one in Supabase; the README has the SQL.";
  const NO_UPDATE_POLICY = "The database would not save this — nothing changed. "
    + "near_expiry_items has no row-level security policy allowing updates for signed-in users. "
    + "An SNT admin needs to add one in Supabase; the README has the SQL.";

  function permissionMessage(error) {
    if (error?.refused) return error.message;
    return /permission|denied|row-level|policy|42501/i.test(`${error?.code || ""} ${error?.message || ""}`)
      ? "Your account is not allowed to delete products. Ask an SNT admin to grant it in Supabase."
      : error?.message || "Product could not be deleted.";
  }

  /* Deleting is immediate and optimistic: the row leaves the table on the click and the
     database catches up behind it. Sold-out stock is cleared in runs, and a confirmation
     plus a full reload between each one made that a chore. The row going is the receipt,
     so a success toast would only be noise; a refusal puts the row back where it was and
     says why. */
  /* storage.remove() reports a policy refusal the way the table delete does — by doing
     nothing and saying nothing. It answers with the objects it actually removed, so whatever
     does not come back is still sitting in the bucket. Returns the paths that stayed. */
  async function removePhotos(paths) {
    const left = [];
    for (let start = 0; start < paths.length; start += CHUNK) {
      const batch = paths.slice(start, start + CHUNK);
      const { data, error } = await client.storage.from(config.photoBucket).remove(batch);
      if (error) { left.push(...batch); continue; }
      const gone = new Set((data || []).flatMap((object) => [object.name, String(object.name).split("/").pop()]));
      left.push(...batch.filter((path) => !gone.has(path) && !gone.has(path.split("/").pop())));
    }
    return left;
  }

  /* ---- photos no product points at ----------------------------------------
     A removal the bucket's policy refuses leaves the file behind with nothing referring to
     it: invisible in the admin, still counting against storage. Walking the bucket and
     subtracting every photo_path in the table is the only way to find them again. */
  async function listStoredPhotos() {
    const found = [];
    const PAGE = 100;
    async function walk(prefix) {
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await client.storage.from(config.photoBucket)
          .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
        if (error) throw error;
        if (!data.length) return;
        for (const entry of data) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          /* A folder comes back with no id of its own. */
          if (entry.id === null || entry.id === undefined) await walk(path);
          else found.push(path);
        }
        if (data.length < PAGE) return;
      }
    }
    await walk("");
    return found;
  }

  async function findOrphanPhotos() {
    setLoading(true, "Reading the photo bucket…");
    try {
      const stored = await listStoredPhotos();
      const used = new Set(state.products.map((item) => item.photo_path).filter(Boolean));
      state.orphans = stored.filter((path) => !used.has(path));
      const used_ = stored.length - state.orphans.length;
      element("#orphanStatus").textContent = state.orphans.length
        ? `${formatNumber(state.orphans.length)} of ${formatNumber(stored.length)} photos in storage belong to no product${used_ ? `, and ${used_ === 1 ? "one is" : `${formatNumber(used_)} are`} in use` : ""}.`
        : `Nothing to clear — ${stored.length === 1 ? "the one photo" : `all ${formatNumber(stored.length)} photos`} in storage ${stored.length === 1 ? "belongs" : "belong"} to a product.`;
      element("#deleteOrphansButton").classList.toggle("hidden", !state.orphans.length);
      element("#deleteOrphansButton").textContent = `Delete ${formatNumber(state.orphans.length)} unused`;
    } catch (error) {
      element("#orphanStatus").textContent = "";
      toast(error.message || "The photo bucket could not be read.", "error");
    } finally { setLoading(false); }
  }

  async function deleteOrphanPhotos() {
    if (!state.orphans.length) return;
    /* Deleting files is not undoable, and this one is driven by a list the operator has not
       read row by row, so it asks. */
    if (!window.confirm(`Permanently delete ${state.orphans.length} photos that no product points at?`)) return;
    setLoading(true, `Deleting ${formatNumber(state.orphans.length)} photos…`);
    try {
      const left = await removePhotos(state.orphans);
      const cleared = state.orphans.length - left.length;
      state.orphans = left;
      element("#deleteOrphansButton").classList.toggle("hidden", !left.length);
      element("#orphanStatus").textContent = left.length
        ? `${formatNumber(cleared)} deleted. ${formatNumber(left.length)} could not be removed — the bucket has no delete policy for this account.`
        : `${formatNumber(cleared)} unused photos deleted.`;
      toast(left.length ? `${formatNumber(cleared)} deleted, ${formatNumber(left.length)} refused by the bucket.` : `${formatNumber(cleared)} unused photos deleted.`, left.length ? "warning" : "success");
    } catch (error) { toast(error.message || "The photos could not be deleted.", "error"); }
    finally { setLoading(false); }
  }

  async function deleteProduct(product) {
    if (!product || state.removing.has(product.id)) return;
    state.removing.add(product.id);
    const position = state.products.indexOf(product);
    state.products.splice(position, 1);
    renderInventory();
    try {
      const { data: removed, error } = await client.from("near_expiry_items").delete().eq("id", product.id).select("id");
      if (error) throw error;
      if (!removed?.length) throw refused(NO_DELETE_POLICY);
      /* The row is gone, so the product is deleted whatever happens next. A photo left behind
         in storage is worth a warning, not a failure the operator has to act on. */
      if (product.photo_path) {
        const left = await removePhotos([product.photo_path]);
        if (left.length) toast(`${product.product_name} was deleted, but its photo is still in storage. Photo inbox → Find unused photos clears these.`, "warning");
      }
    } catch (error) {
      state.products.splice(Math.min(position, state.products.length), 0, product);
      renderInventory();
      toast(permissionMessage(error), "error");
    } finally {
      state.removing.delete(product.id);
    }
  }

  /* Delete all clears exactly what the table is showing, not the whole catalogue behind a
     filter - "sold only, delete all" is the reason it exists. The dialog names the count
     and the filter so the two can never be confused, and this one does confirm: it is the
     single click that cannot be walked back. */
  function describeSelection(count) {
    const [one, many] = {
      available: ["available product", "available products"],
      sold: ["sold product", "sold products"],
      expired: ["expired product still listed", "expired products still listed"],
      nophoto: ["product with no photo of its own", "products with no photo of their own"]
    }[elements.statusFilter.value] || ["product", "products"];
    const search = elements.search.value.trim();
    return `${formatNumber(count)} ${count === 1 ? one : many}${search ? ` matching “${search}”` : ""}`;
  }

  async function deleteAllShown() {
    const doomed = state.deletingAll || [];
    if (!doomed.length) return;
    elements.deleteAllDialog.close();
    state.deletingAll = null;

    const ids = doomed.map((item) => item.id);
    setLoading(true, `Deleting ${formatNumber(ids.length)} products…`);
    try {
      /* Track which rows actually went, so a partly refused run still clears the photos of
         the products it did delete instead of orphaning every one of them. */
      const byId = new Map(doomed.map((item) => [item.id, item]));
      const deleted = [];
      for (let start = 0; start < ids.length; start += CHUNK) {
        const chunk = ids.slice(start, start + CHUNK);
        const { data, error } = await client.from("near_expiry_items").delete().in("id", chunk).select("id");
        if (error) throw error;
        deleted.push(...(data || []).map((row) => row.id));
        setLoading(true, `Deleted ${formatNumber(deleted.length)} of ${formatNumber(ids.length)}…`);
      }
      /* Nothing removed at all is the policy refusing outright; a shortfall means some rows
         were kept, and saying so beats a success message the inventory contradicts. */
      if (!deleted.length) throw refused(NO_DELETE_POLICY);

      setLoading(true, "Removing photos…");
      const left = await removePhotos(deleted.map((id) => byId.get(id)?.photo_path).filter(Boolean));
      await loadProducts();

      const kept = ids.length - deleted.length;
      const parts = [`${formatNumber(deleted.length)} products deleted`];
      if (kept) parts.push(`the database kept the other ${formatNumber(kept)}`);
      if (left.length) parts.push(`${formatNumber(left.length)} photos are still in storage — Photo inbox → Find unused photos clears them`);
      toast(`${parts.join(" — ")}.`, kept || left.length ? "warning" : "success");
    } catch (error) {
      /* Part of the run may already be gone, so reload rather than guess what survived. */
      await loadProducts();
      toast(permissionMessage(error), "error");
    } finally { setLoading(false); }
  }

  /* ---------------------------------------------------------------- Excel */

  function columnOptions(selected = "", optional = false) {
    return `${optional ? '<option value="">Not provided</option>' : '<option value="">Select column</option>'}${state.headers.map((header) => `<option value="${escapeHtml(header)}" ${header === selected ? "selected" : ""}>${escapeHtml(header)}</option>`).join("")}`;
  }

  /* Prefer the expiry exactly as it was typed. Spreadsheet readers guess at "11/26" and turn it
     into 26 November 2001; the text is what the pharmacist actually meant (Nov 2026). Only when
     the text is unreadable do we fall back to the cell's real date or Excel serial number. */
  function excelExpiry(text, raw) {
    const fromText = parseExpiry(text);
    if (fromText) return fromText;
    if (raw instanceof Date) return parseExpiry(raw);
    if (typeof raw === "number" && window.XLSX) {
      const parsed = XLSX.SSF.parse_date_code(raw);
      return parsed && parsed.y && parsed.m ? parseExpiry(`${parsed.y}-${String(parsed.m).padStart(2, "0")}`) : null;
    }
    return null;
  }

  function currentMapping() {
    return {
      product: element("#mapProduct").value, salt: element("#mapSalt").value, expiry: element("#mapExpiry").value,
      quantity: element("#mapQuantity").value, batch: element("#mapBatch").value,
      price: state.hasPrice ? element("#mapPrice").value : "",
      company: state.hasCompany ? element("#mapCompany").value : ""
    };
  }

  /* Parse the whole sheet up front so the admin sees exactly what would be published. */
  function parseWorkbook() {
    const mapping = currentMapping();
    state.parsed = state.workbookRows.map((row, index) => {
      const rawRow = state.rawRows[index] || {};
      const sheetName = String(row[mapping.product] ?? "").trim();
      const sheetCompany = sheetCompanyOf(row, mapping);

      /* Strictly what was decided for this product + company pair. There is deliberately no
         fall-back to an exact name lookup here: a name that matches a catalogue product
         exactly but belongs to another manufacturer is precisely what the company gate
         exists to refuse, and a lookup behind it would hand that match straight back. */
      const key = matchKey(sheetName, sheetCompany);
      const chosen = state.matches.get(key) || "";
      const matched = chosen ? masterByName(chosen) : null;
      const name = matched?.name || sheetName;

      const rawExpiry = mapping.expiry ? row[mapping.expiry] : "";
      const expiry = excelExpiry(rawExpiry, mapping.expiry ? rawRow[mapping.expiry] : "");
      const batch = mapping.batch ? String(row[mapping.batch] ?? "").trim() : "";
      const quantity = window.SNTSheet.parseQuantity(mapping.quantity ? row[mapping.quantity] : "");
      /* The sheet's own composition wins where it has one; the master fills the rest. A row
         with no match gets neither invented for it. */
      const salt = (mapping.salt ? String(row[mapping.salt] ?? "").trim() : "") || matched?.salt || "";
      /* A matched row publishes under the catalogue's spelling of the company as well as its
         name, so "ALKEM-FUT" cannot become a third spelling in the inventory. An unmatched
         row keeps whatever the sheet said. */
      const company = (matched?.company || sheetCompany || "");
      const rawPrice = mapping.price ? row[mapping.price] : "";
      const price = parsePrice(rawPrice);

      const problems = [];
      if (!sheetName) problems.push("no product name");
      if (!expiry) problems.push(`expiry "${String(rawExpiry ?? "").trim() || "blank"}" not understood`);
      if (quantity.problem) problems.push(quantity.problem);

      const warnings = [];
      if (quantity.warning) warnings.push(quantity.warning);
      /* An unreadable price is a warning, not a reason to drop a whole product row. */
      if (mapping.price && String(rawPrice ?? "").trim() && price === null) {
        warnings.push(`price "${String(rawPrice).trim()}" not understood — imported without a price`);
      }

      return {
        line: index + 2, name, sheetName, sheetCompany, matchKey: key,
        matched: Boolean(matched), salt, company, batch,
        quantity: quantity.quantity ?? 0, expiry, rawExpiry, price, problems, warnings
      };
    });
    return state.parsed;
  }

  /* Two lines of the same product, batch and expiry are two deliveries of it, so the
     quantities are added. Keeping only the last is how a sheet listing 40 and then 60
     imports as 60 and the other 40 quietly stops existing. */
  function importKey(row) {
    return `${normalise(row.name)}|${normalise(row.batch)}|${row.expiry}`;
  }

  function mergedRows(parsed) {
    return window.SNTSheet.mergeDuplicates(parsed.filter((row) => !row.problems.length), importKey);
  }

  /* ---- asking the matcher --------------------------------------------------
     One pass over the sheet, kept out of renderPreview so remapping a column does not
     recompute the whole search, and keyed by product + company so a sheet listing the same
     product in six batches is one question rather than six. */
  function computeSuggestions() {
    state.suggestions = new Map();
    const mapping = currentMapping();
    if (!mapping.product || !state.matchIndex) return;
    state.workbookRows.forEach((row) => {
      const name = String(row[mapping.product] ?? "").trim();
      if (!name) return;
      const company = sheetCompanyOf(row, mapping);
      const key = matchKey(name, company);
      if (state.suggestions.has(key)) return;
      const result = window.SNTMatching.suggestMatches(state.matchIndex, name, company);
      state.suggestions.set(key, { key, name, company, result });
    });

    /* Only what cleared the automatic gate is filled in. Everything else is listed with its
       candidates and left blank on purpose: a top candidate its runner-up is breathing down
       the neck of is a flavour, a strength or a pack that a person has to settle, and
       pre-filling it is how that decision gets made by nobody. */
    state.suggestions.forEach((entry, key) => {
      if (state.matches.has(key)) return;
      state.matches.set(key, entry.result.auto ? entry.result.auto.name : "");
    });
  }

  /* What the row is, in the operator's terms rather than the scorer's.

       matched  - cleared the automatic gate: high score and clear of its runner-up
       manual   - a person typed or clicked it, which is not something to second-guess
       check    - candidates exist, none of them safely enough to be chosen for anyone
       rejected - suggestions were offered and deliberately turned down
       none     - the catalogue has nothing close under this company */
  function matchConfidence(key) {
    const entry = state.suggestions.get(key);
    if (!entry) return "none";
    const chosen = state.matches.get(key) || "";
    if (!chosen) return entry.result.suggestions.length ? "rejected" : "none";
    /* Chosen by hand if it is not the one the gate would have picked itself. */
    return entry.result.auto && entry.result.auto.name === chosen ? "matched" : "manual";
  }

  const MATCH_LABELS = {
    matched: "Matched", manual: "Chosen by you", check: "Suggested — check it",
    rejected: "Keeping the sheet name", none: "Nothing close in the catalogue"
  };

  /* A row with candidates and no decision is the one that wants attention, so it reads as
     "check" rather than as a rejection until somebody actually rejects it. */
  function matchState(key) {
    const confidence = matchConfidence(key);
    if (confidence === "rejected" && !state.decided.has(key)) return "check";
    return confidence;
  }

  function matchCounts() {
    const counts = { matched: 0, manual: 0, check: 0, none: 0, rejected: 0, total: state.suggestions.size };
    state.suggestions.forEach((_entry, key) => { counts[matchState(key)] += 1; });
    return counts;
  }

  function summaryMarkup() {
    const counts = matchCounts();
    return [
      `<span class="pill pill--ok">${formatNumber(counts.matched)} matched automatically</span>`,
      counts.manual ? `<span class="pill">${formatNumber(counts.manual)} chosen by you</span>` : "",
      counts.check ? `<span class="pill pill--warn">${formatNumber(counts.check)} to check</span>` : "",
      counts.none + counts.rejected ? `<span class="pill">${formatNumber(counts.none + counts.rejected)} keeping the sheet name</span>` : ""
    ].filter(Boolean).join("");
  }

  /* Any catalogue product can be typed in, not only the four that scored well: a suggestion
     that is wrong must never be a dead end. The name has to be a real one, so what is typed
     is resolved against the master and anything else is said out loud rather than silently
     kept or silently dropped. */
  function chooseMatch(key, value) {
    const typed = String(value ?? "").trim();
    state.matchNotes.delete(key);
    state.decided.add(key);
    if (!typed) {
      state.matches.set(key, "");
    } else {
      const exact = state.master.find((item) => item.name === typed)
        || state.master.find((item) => item.name.toLowerCase() === typed.toLowerCase())
        || state.master.find((item) => normalise(item.name) === normalise(typed));
      state.matches.set(key, exact ? exact.name : "");
      if (!exact) state.matchNotes.set(key, `“${typed}” is not in the SNT catalogue — keeping the sheet name.`);
    }
    repaintMatchRow(key);
    element("#matchSummary").innerHTML = summaryMarkup();
    renderPreview();
  }

  function repaintMatchRow(key) {
    const row = element(`[data-match-row="${CSS.escape(key)}"]`);
    if (row) row.outerHTML = matchRowMarkup(key);
  }

  function renderPreview() {
    if (!state.workbookRows.length) return;
    const mapping = currentMapping();
    const ready = Boolean(mapping.product && mapping.expiry && mapping.quantity);
    const summary = element("#validationSummary");
    const wrap = element("#previewWrap");
    if (!ready) {
      element("#importButton").disabled = true;
      wrap.classList.add("hidden");
      summary.innerHTML = '<span class="warn">Map Product, Expiry and Quantity to see the preview</span>';
      element("#importPreview").textContent = `${formatNumber(state.workbookRows.length)} rows read from the sheet.`;
      return;
    }
    const parsed = parseWorkbook();
    const valid = parsed.filter((row) => !row.problems.length);
    const invalid = parsed.filter((row) => row.problems.length);
    /* Merged, not de-duplicated: two lines of the same batch are added together, so the
       count here is the count that will be written. */
    const merged = mergedRows(parsed);
    const duplicates = valid.length - merged.length;
    const zeroQuantity = merged.filter((row) => row.quantity <= 0).length;
    const rounded = valid.filter((row) => row.warnings.some((warning) => warning.startsWith("quantity"))).length;
    const priceWarnings = valid.filter((row) => row.warnings.some((warning) => warning.startsWith("price"))).length;
    const badQuantity = invalid.filter((row) => row.problems.some((problem) => problem.startsWith("quantity"))).length;

    summary.innerHTML = [
      `<span class="ok">${formatNumber(merged.length)} ready to import</span>`,
      duplicates ? `<span class="warn">${formatNumber(duplicates)} duplicate rows merged — quantities added</span>` : "",
      zeroQuantity ? `<span class="warn">${formatNumber(zeroQuantity)} with quantity 0 → marked sold</span>` : "",
      rounded ? `<span class="warn">${formatNumber(rounded)} decimal quantities rounded down</span>` : "",
      priceWarnings ? `<span class="warn">${formatNumber(priceWarnings)} with an unreadable price</span>` : "",
      badQuantity ? `<span class="bad">${formatNumber(badQuantity)} with an unusable quantity</span>` : "",
      invalid.length ? `<span class="bad">${formatNumber(invalid.length)} skipped</span>` : ""
    ].filter(Boolean).join("");

    /* Bad rows first — those are the ones the admin has to go and fix in the sheet. */
    const ordered = [...invalid, ...parsed.filter((row) => !row.problems.length)].slice(0, PREVIEW_ROWS);
    element("#previewRows").innerHTML = ordered.map((row) => `<tr class="${row.problems.length ? "row-bad" : ""}">
      <td title="${escapeHtml(row.name)}">${escapeHtml(row.name || "—")}${row.problems.length ? `<span class="skip-reason">Skipped — ${escapeHtml(row.problems.join("; "))}</span>` : ""}${!row.problems.length && row.warnings.length ? `<span class="warn-reason">${escapeHtml(row.warnings.join("; "))}</span>` : ""}</td>
      <td title="${escapeHtml(row.salt)}">${escapeHtml(row.salt || "—")}</td>
      <td class="cell-exp" title="${escapeHtml(row.problems.join("; ") || "")}">${row.expiry ? formatExpiry(row.expiry) : escapeHtml(String(row.rawExpiry ?? "").trim() || "blank")}</td>
      <td class="cell-num">${formatNumber(row.quantity)}</td>
      <td class="cell-price${state.hasPrice ? "" : " hidden"}" data-price-column>${escapeHtml(formatPrice(row.price)) || "—"}</td>
      <td class="cell-company${state.hasCompany ? "" : " hidden"}" data-company-column>${escapeHtml(row.company) || "—"}</td>
      <td>${escapeHtml(row.batch || "—")}</td>
    </tr>`).join("");
    wrap.classList.remove("hidden");

    element("#importPreview").textContent = invalid.length
      ? `${formatNumber(invalid.length)} ${invalid.length === 1 ? "row is" : "rows are"} highlighted and will be skipped — first is sheet row ${invalid[0].line} (${invalid[0].problems.join(", ")}). Fix the sheet and re-select it, or import the rest.`
      : `Showing the first ${formatNumber(Math.min(PREVIEW_ROWS, parsed.length))} of ${formatNumber(parsed.length)} rows.`;
    const counts = matchCounts();
    const review = element("#reviewMatchesButton");
    review.classList.toggle("hidden", !counts.total);
    review.textContent = counts.check
      ? `Check ${formatNumber(counts.check)} suggested matches`
      : `Matched ${formatNumber(counts.matched + counts.manual)} of ${formatNumber(counts.total)}`;
    review.classList.toggle("danger-button", Boolean(counts.check));
    review.classList.toggle("secondary-button", !counts.check);
    element("#importButton").disabled = merged.length === 0;
    element("#importButton").textContent = `Import ${formatNumber(merged.length)} products`;
  }

  /* ---- the match review dialog ---------------------------------------------
     Opened once the sheet is read, because this is the moment the decisions are cheap: the
     name settled on here is the one the catalogue publishes, and it carries the salt and
     the pack photo with it. Rows needing a look are listed first. */

  function matchRowMarkup(key) {
    const entry = state.suggestions.get(key);
    if (!entry) return "";
    const { name, company, result } = entry;
    const chosen = state.matches.get(key) || "";
    const status = matchState(key);
    const label = MATCH_LABELS[status];
    const target = chosen ? masterByName(chosen) : null;
    const photo = chosen ? websitePhoto(chosen) : "";
    const note = state.matchNotes.get(key) || "";
    const picked = result.suggestions.find((suggestion) => suggestion.name === chosen) || null;

    /* The numbers behind the verdict, said plainly. The lead is the half operators do not
       otherwise see, and it is the half that decides: a 94% top candidate one point ahead of
       a 93% one is not a match, it is a question. */
    const confidence = picked
      ? `${Math.round(picked.score * 100)}% match${picked === result.top && result.runnerUp
          ? `, ${Math.round(result.lead * 100)} points clear of the next` : ""}`
      : result.top
        ? `best candidate ${Math.round(result.top.score * 100)}%${result.runnerUp
            ? `, only ${Math.round(result.lead * 100)} points clear of the next` : ""}`
        : "";

    /* A choice from another manufacturer stays possible - the operator may know something
       the sheet does not say - but it never passes quietly. Both companies are named.

       This is worked out from the master record rather than from the suggestion the pick
       came from, because a cross-company product is never in that list: the gate removed it
       before scoring, which is the only way to reach one at all. Reading the company off a
       suggestion would mean the warning could never fire. */
    const crossCompany = target && company && !window.SNTMatching.companiesCompatible(
      window.SNTMatching.normalizeCompany(company), window.SNTMatching.normalizeCompany(target.company));

    /* The runners-up stay one click away and the field itself searches the whole catalogue,
       so a wrong suggestion is never a dead end. */
    const others = result.suggestions.filter((suggestion) => suggestion.name !== chosen).slice(0, 3);
    const chips = [
      ...others.map((suggestion) => `<button class="match-chip" type="button" data-pick-for="${escapeHtml(key)}" data-pick="${escapeHtml(suggestion.name)}">${escapeHtml(suggestion.name)} · ${Math.round(suggestion.score * 100)}%</button>`),
      chosen ? `<button class="match-chip match-chip--clear" type="button" data-pick-for="${escapeHtml(key)}" data-pick="">Keep the sheet name</button>` : ""
    ].filter(Boolean).join("");

    return `<tr class="match-row match-row--${status}" data-match-row="${escapeHtml(key)}">
      <td class="match-cell-photo">${photo
        ? `<img class="table-photo" src="${escapeHtml(photo)}" alt="" loading="lazy">`
        : '<span class="table-photo table-photo--none">none</span>'}</td>
      <td>
        <strong>${escapeHtml(name)}</strong>
        <small class="match-source">${escapeHtml(company || "no company on the sheet")}</small>
        <span class="match-state ${status}">${label}</span>${confidence
          ? `<span class="match-confidence">${escapeHtml(confidence)}</span>` : ""}
        <input class="match-input" type="text" list="productMasterNames" autocomplete="off" spellcheck="false"
          data-match-for="${escapeHtml(key)}" value="${escapeHtml(chosen)}"
          aria-label="Catalogue product for ${escapeHtml(name)}"
          placeholder="Type any SNT product — leave blank to keep the sheet name">
        ${note ? `<span class="match-warn">${escapeHtml(note)}</span>` : ""}
        ${crossCompany ? `<span class="match-warn">The sheet says ${escapeHtml(company)}; ${escapeHtml(chosen)} is ${escapeHtml(target.company || "another company")}. Importing this publishes the stock under a company the sheet did not name.</span>` : ""}
        ${chips ? `<div class="match-chips">${chips}</div>` : ""}
      </td>
      <td class="match-cell-salt">${target
        ? `${escapeHtml(target.salt || "") || '<span class="faint">No composition in the master</span>'}<small class="match-target-company">${escapeHtml(target.company || "")}</small>`
        : '<span class="faint">No salt until a product is chosen</span>'}</td>
    </tr>`;
  }

  function renderMatchDialog() {
    element("#matchSummary").innerHTML = summaryMarkup();

    /* Uncertain guesses first - those are the ones worth the operator's attention - then the
       products the catalogue simply does not have, then the matches needing no thought. */
    const order = { check: 0, rejected: 1, none: 2, manual: 3, matched: 4 };
    const rows = [...state.suggestions.values()].sort((a, b) =>
      (order[matchState(a.key)] - order[matchState(b.key)]) || a.name.localeCompare(b.name));
    element("#matchRows").innerHTML = rows.map((entry) => matchRowMarkup(entry.key)).join("");
    const counts = matchCounts();
    element("#matchNote").textContent = counts.none
      ? `${formatNumber(counts.none)} products are not in the SNT catalogue under the company the sheet names — they import under the sheet's own name, without a salt or a photo.`
      : "Every product was found in the SNT catalogue.";
  }

  function openMatchDialog() {
    if (!state.suggestions.size) return;
    renderMatchDialog();
    if (!elements.matchDialog.open) elements.matchDialog.showModal();
  }

  async function readExcel(file) {
    if (!requireLibrary("The spreadsheet reader", "XLSX")) return;
    setLoading(true, "Reading spreadsheet…");
    try {
      /* raw:true stops the CSV reader type-guessing "11/26" into 26 November 2001.
         codepage 65001 reads text files as UTF-8 — without it a CSV mangles every non-ASCII
         character, so Gujarati and Hindi product names and the ₹ sign import as mojibake.
         Real .xlsx files are XML and already UTF-8, so both options leave them untouched. */
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: true, codepage: 65001 });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      /* Row 1 is not the header often enough to matter: these sheets open with a company
         banner, a date, a blank line and a "NEAR EXPIRY STOCK STATEMENT" title, and reading
         the title as the header makes every column name wrong and every row a mismatch. So
         the sheet is read once as a bare grid to find the row that really names product,
         expiry and quantity, and only then read properly from there. */
      const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false, blankrows: true });
      const headerRow = window.SNTSheet.findHeaderRow(matrix);
      /* Two views of the same sheet: cells as they read on screen, and the underlying
         values, so a genuine date cell still resolves when its text is ambiguous. */
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false, range: headerRow });
      if (!rows.length) throw new Error("The first worksheet has no data rows.");
      state.workbookRows = rows;
      state.rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: true, range: headerRow });
      state.headerRow = headerRow;
      /* Union of keys — the first row alone misses columns that start out blank. */
      state.headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const selected = window.SNTSheet.detectColumns(state.headers);
      element("#mapProduct").innerHTML = columnOptions(selected.product);
      element("#mapSalt").innerHTML = columnOptions(selected.salt, true);
      element("#mapExpiry").innerHTML = columnOptions(selected.expiry);
      element("#mapQuantity").innerHTML = columnOptions(selected.quantity);
      element("#mapBatch").innerHTML = columnOptions(selected.batch, true);
      element("#mapPrice").innerHTML = columnOptions(selected.price, true);
      element("#mapCompany").innerHTML = columnOptions(selected.company, true);
      element("#excelFileStatus").textContent = headerRow
        ? `${file.name} · ${formatNumber(rows.length)} rows · header found on row ${headerRow + 1}`
        : `${file.name} · ${formatNumber(rows.length)} rows`;
      state.matches = new Map();
      state.matchNotes = new Map();
      state.decided = new Set();
      computeSuggestions();
      renderPreview();
      openMatchDialog();
    } catch (error) { toast(error.message || "Spreadsheet could not be read.", "error"); }
    finally { setLoading(false); }
  }

  /* Rows already in the database that the operator has now matched to a catalogue name are
     renamed by id before anything is upserted, so the upsert meets the record it is meant to
     update rather than creating its twin. */
  async function renameToCatalogueNames(renames) {
    if (!renames.length) return 0;
    let renamed = 0;
    const BATCH = 20;
    for (let start = 0; start < renames.length; start += BATCH) {
      const batch = renames.slice(start, start + BATCH);
      const results = await Promise.all(batch.map(({ id, product_name }) =>
        client.from("near_expiry_items").update({ product_name, updated_by: state.user.id }).eq("id", id).select("id")));
      const failed = results.find((result) => result.error);
      if (failed) throw failed.error;
      renamed += results.reduce((count, result) => count + (result.data?.length || 0), 0);
      setLoading(true, `Renaming ${formatNumber(renamed)} of ${formatNumber(renames.length)} to their catalogue names…`);
    }
    /* Silence here would mean an update policy is refusing, and the upsert that follows would
       then duplicate every renamed product. */
    if (!renamed) throw refused(NO_UPDATE_POLICY);
    return renamed;
  }

  async function importExcel() {
    /* Merged before anything else, so a product listed twice reaches the database once with
       both quantities added rather than once with the second line's alone. Merging on the
       final name means it happens after matching, which is the only order that works: two
       sheet spellings of one product become one row only once they are both the catalogue's
       name. */
    const parsed = mergedRows(state.parsed);
    if (!parsed.length) return toast("There are no valid rows to import.", "error");
    const mapping = currentMapping();
    const keepSold = element("#keepSoldStatus").checked;
    const identify = (name, batch, expiry) => `${normalise(name)}|${normalise(batch)}|${expiry}`;
    const existing = new Map(state.products.map((item) => [identify(item.product_name, item.batch_no, item.expiry_date), item]));

    /* A matched product publishes under the catalogue's name, but a row imported before the
       match was made still carries the sheet's. Both identities have to be tried: by the new
       name for rows imported since, by the sheet's for rows imported before. Looking only at
       the new one loses the record twice over - "keep sold" stops recognising the row and
       puts hand-marked stock back on the public site, and import_key, generated from the row
       itself, no longer collides, so the upsert inserts a second product instead of updating
       the first and the old name stays listed beside it. Renaming in place first settles
       both. */
    const renames = [];

    const unique = new Map();
    parsed.forEach((row) => {
      const key = identify(row.name, row.batch, row.expiry);
      let current = existing.get(key);
      if (!current && row.sheetName && row.sheetName !== row.name) {
        const beforeMatching = existing.get(identify(row.sheetName, row.batch, row.expiry));
        if (beforeMatching) {
          current = beforeMatching;
          renames.push({ id: beforeMatching.id, product_name: row.name });
        }
      }
      /* A row someone marked sold, whose sheet quantity has not moved since, is a stale
         sheet line rather than a restock — leave it sold instead of putting phantom stock
         back on the public site. A changed quantity means the sheet is the fresher truth. */
      const staleSoldRow = keepSold && current?.status === "sold" && Number(current.quantity) === row.quantity;
      unique.set(key, {
        product_name: row.name, salt_name: row.salt, batch_no: row.batch || null,
        expiry_date: row.expiry, quantity: row.quantity,
        status: row.quantity > 0 && !staleSoldRow ? "available" : "sold",
        source: "excel", created_by: state.user.id, updated_by: state.user.id,
        /* Keep a price already on the record when the sheet has no price column. */
        ...(state.hasPrice && (mapping.price || row.price !== null) ? { price: row.price } : {}),
        /* Only write a company we actually resolved, so a re-import from a sheet without
           the column cannot blank one that is already on the record. */
        ...(state.hasCompany && row.company ? { company: row.company } : {})
      });
    });
    const records = [...unique.values()];

    setLoading(true, `Importing ${formatNumber(records.length)} products…`);
    element("#importButton").disabled = true;
    try {
      await renameToCatalogueNames(renames);
      for (let start = 0; start < records.length; start += CHUNK) {
        const chunk = records.slice(start, start + CHUNK);
        const { error } = await client.from("near_expiry_items").upsert(chunk, { onConflict: "import_key", ignoreDuplicates: false });
        if (error) throw error;
        element("#importProgress").style.width = `${Math.round(((start + chunk.length) / records.length) * 100)}%`;
      }
      await loadProducts();
      toast(`${formatNumber(records.length)} products imported.`);
    } catch (error) { toast(error.message || "Excel import failed.", "error"); }
    finally { setLoading(false); element("#importButton").disabled = false; setTimeout(() => { element("#importProgress").style.width = "0"; }, 800); }
  }

  /* ---------------------------------------------------------------- Photos */

  function mimeForName(name) {
    const extension = String(name).split(".").pop().toLowerCase();
    return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", gif: "image/gif" })[extension] || "application/octet-stream";
  }

  async function imageFilesFromZip(file) {
    if (!requireLibrary("The ZIP reader", "fflate")) return [];
    const entries = fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
    return Object.entries(entries)
      .filter(([name]) => /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(name) && !name.startsWith("__MACOSX/"))
      .map(([name, bytes]) => new File([bytes], name.split("/").pop(), { type: mimeForName(name) }));
  }

  function productSuggestions(filename) {
    const source = searchable(filename.replace(/\.[^.]+$/, ""));
    const tokens = source.split(" ").filter((token) => token.length > 1 && !/^(img|wa|jpg|jpeg|png|image|photo|media|copy|20\d\d)$/.test(token));
    return state.products.map((product) => {
      const target = searchable(product.product_name);
      const score = tokens.filter((token) => target.includes(token)).length + (source && target.includes(source) ? 4 : 0);
      return { product, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((item) => item.product);
  }

  /* Read what the admin typed back into state before any re-render — otherwise a second
     drop of photos silently throws away every name they had corrected by hand. */
  function syncInboxInputs() {
    elements.photoInbox.querySelectorAll("[data-photo-key]").forEach((card) => {
      const photo = state.photos.find((item) => item.key === card.dataset.photoKey);
      const input = card.querySelector("[data-photo-product]");
      if (photo && input) photo.productName = input.value.trim();
    });
  }

  async function readPhotoFiles(fileList) {
    syncInboxInputs();
    setLoading(true, "Opening photos…");
    try {
      const files = [];
      for (const file of fileList) {
        if (/\.zip$/i.test(file.name) || file.type === "application/zip") files.push(...await imageFilesFromZip(file));
        else if (file.type.startsWith("image/")) files.push(file);
      }
      if (!files.length) { toast("No images were found in that selection.", "warning"); return; }
      const next = files.map((file) => {
        const suggestions = productSuggestions(file.name);
        return { key: crypto.randomUUID(), file, url: URL.createObjectURL(file), productName: suggestions[0]?.product_name || "", suggestions };
      });
      state.photos.push(...next);
      renderPhotoInbox();
      toast(`${next.length} ${next.length === 1 ? "photo" : "photos"} added to the inbox.`);
    } catch (error) { toast(error.message || "Photos could not be opened.", "error"); }
    finally { setLoading(false); element("#photoFiles").value = ""; }
  }

  function matchedProduct(name) {
    const key = normalise(name);
    return key ? state.products.find((item) => normalise(item.product_name) === key) : null;
  }

  function renderPhotoInbox() {
    const matched = state.photos.filter((photo) => matchedProduct(photo.productName)).length;
    element("#photoTabCount").textContent = state.photos.length ? String(state.photos.length) : "";
    element("#photoStatus").textContent = state.photos.length
      ? `${formatNumber(state.photos.length)} waiting · ${formatNumber(matched)} matched to a product · ${formatNumber(state.photos.length - matched)} need a name`
      : "No photos waiting.";
    element("#uploadMatchedButton").disabled = matched === 0;
    element("#uploadMatchedButton").textContent = matched ? `Upload ${formatNumber(matched)} matched` : "Upload matched";
    element("#clearInbox").disabled = state.photos.length === 0;
    element("#applySuggestions").disabled = !state.photos.some((photo) => !photo.productName && photo.suggestions.length);

    elements.photoInbox.innerHTML = state.photos.map((photo) => {
      const isMatched = Boolean(matchedProduct(photo.productName));
      return `<article class="photo-match-card ${isMatched ? "is-matched" : ""}" data-photo-key="${escapeHtml(photo.key)}">
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.file.name)}">
        <div class="photo-match-card__body">
          <h3 title="${escapeHtml(photo.file.name)}">${escapeHtml(photo.file.name)}</h3>
          <label class="sr-only" for="photo-${escapeHtml(photo.key)}">Product for ${escapeHtml(photo.file.name)}</label>
          <input id="photo-${escapeHtml(photo.key)}" class="field-input" list="inventoryProductNames" value="${escapeHtml(photo.productName)}" placeholder="Type the product name" data-photo-product autocomplete="off">
          <span class="match-state ${isMatched ? "ok" : "no"}">${isMatched ? "✓ Matched" : "Needs an exact product name"}</span>
          ${photo.suggestions.length ? `<div class="suggestions">${photo.suggestions.map((item) => `<button type="button" data-suggest="${escapeHtml(item.product_name)}" title="${escapeHtml(item.product_name)}">${escapeHtml(item.product_name)}</button>`).join("")}</div>` : ""}
          <button class="icon-button danger" type="button" data-remove-photo>Remove</button>
        </div>
      </article>`;
    }).join("");
  }

  async function uploadMatchedPhotos() {
    syncInboxInputs();
    const matched = state.photos.filter((photo) => matchedProduct(photo.productName));
    if (!matched.length) return toast("Match at least one photo to an exact product name.", "error");
    setLoading(true, `Uploading ${matched.length} original photos…`);
    let completed = 0;
    try {
      for (const photo of matched) {
        await uploadPhoto(matchedProduct(photo.productName), photo.file);
        completed += 1;
        URL.revokeObjectURL(photo.url);
        state.photos = state.photos.filter((item) => item.key !== photo.key);
        element("#photoProgress").style.width = `${Math.round((completed / matched.length) * 100)}%`;
      }
      await loadProducts(); renderPhotoInbox(); toast(`${completed} original photos uploaded.`);
    } catch (error) {
      await loadProducts(); renderPhotoInbox();
      toast(`${completed} uploaded. ${error.message || "One photo failed."}`, "error");
    }
    finally { setLoading(false); setTimeout(() => { element("#photoProgress").style.width = "0"; }, 800); }
  }

  /* Turn a <label class="drop-zone"> into a real drag target for its own file input. */
  function wireDropZone(zoneSelector, inputSelector, handler) {
    const zone = element(zoneSelector);
    const input = element(inputSelector);
    if (!zone || !input) return;
    ["dragenter", "dragover"].forEach((type) => zone.addEventListener(type, (event) => {
      event.preventDefault(); zone.classList.add("is-dragging");
    }));
    ["dragleave", "dragend", "drop"].forEach((type) => zone.addEventListener(type, () => zone.classList.remove("is-dragging")));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) handler(input.multiple ? files : files[0]);
    });
  }

  /* ---------------------------------------------------------------- Wiring */

  element("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault(); setLoading(true, "Signing in…");
    const { error } = await client.auth.signInWithPassword({ email: element("#loginEmail").value.trim(), password: element("#loginPassword").value });
    if (error) { setLoading(false); return toast(error.message, "error"); }
    try { await currentIdentity(); await showAuthenticated(); element("#loginPassword").value = ""; }
    catch (identityError) { showLogin(); toast(identityError.message, "error"); }
    finally { setLoading(false); }
  });
  element("#signOutButton").addEventListener("click", async () => { await client.auth.signOut(); showLogin(); toast("Signed out."); });

  document.querySelector(".admin-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-admin-tab]");
    if (!button) return;
    document.querySelectorAll("[data-admin-tab]").forEach((item) => item.classList.toggle("is-active", item === button));
    document.querySelectorAll("[data-admin-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.adminPanel === button.dataset.adminTab));
  });

  elements.search.addEventListener("input", renderInventory);
  elements.statusFilter.addEventListener("change", renderInventory);
  element("#addProductButton").addEventListener("click", () => resetProductForm(null));
  document.querySelectorAll("[data-close-product]").forEach((button) => button.addEventListener("click", closeProductForm));
  elements.formDialog.addEventListener("cancel", () => { state.editing = null; });
  /* The master already knows the salt and the company for every catalogue product, so a
     recognised name fills both in. Anything typed by hand is left alone. */
  element("#productName").addEventListener("change", (event) => {
    const match = masterMatch(event.target.value);
    if (!match) return;
    if (!element("#saltName").value.trim()) element("#saltName").value = match.salt || "";
    if (!element("#productCompany").value.trim()) element("#productCompany").value = match.company || "";
  });
  element("#productQuantity").addEventListener("input", updateFormNote);
  element("#productStatus").addEventListener("change", updateFormNote);
  element("#productForm").addEventListener("submit", saveProduct);

  elements.rows.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit]");
    const remove = event.target.closest("[data-delete]");
    const toggle = event.target.closest("[data-toggle-status]");
    const find = (id) => state.products.find((item) => item.id === id) || null;
    if (edit) resetProductForm(find(edit.dataset.edit));
    if (toggle) toggleStatus(find(toggle.dataset.toggleStatus));
    if (remove) deleteProduct(find(remove.dataset.delete));
  });

  element("#deleteAllButton").addEventListener("click", () => {
    const doomed = filteredProducts();
    if (!doomed.length) return;
    state.deletingAll = doomed;
    element("#deleteAllCount").textContent = describeSelection(doomed.length);
    const withPhotos = doomed.filter((item) => item.photo_path).length;
    element("#deleteAllDetails").textContent = withPhotos
      ? `${withPhotos === 1 ? "One has" : `${formatNumber(withPhotos)} of them have`} an uploaded photo, which is deleted too.`
      : "None of them have an uploaded photo.";
    element("#deleteAllMessage").textContent = doomed.length === state.products.length
      ? "That is the whole catalogue. This cannot be undone."
      : "Only the products currently shown are deleted. This cannot be undone.";
    elements.deleteAllDialog.showModal();
  });
  element("#cancelDeleteAll").addEventListener("click", () => { state.deletingAll = null; elements.deleteAllDialog.close(); });
  elements.deleteAllDialog.addEventListener("cancel", () => { state.deletingAll = null; });
  element("#confirmDeleteAll").addEventListener("click", deleteAllShown);

  element("#excelFile").addEventListener("change", (event) => { if (event.target.files[0]) readExcel(event.target.files[0]); });
  ["#mapSalt", "#mapExpiry", "#mapQuantity", "#mapBatch", "#mapPrice"].forEach((id) => element(id).addEventListener("change", renderPreview));
  /* Changing which column holds the name invalidates every match. */
  /* Changing which column holds the name or the company invalidates every match: both are
     inputs to the decision, and a company read from the wrong column is exactly the mistake
     the gate is there to catch. */
  ["#mapProduct", "#mapCompany"].forEach((id) => element(id).addEventListener("change", () => {
    state.matches = new Map(); state.matchNotes = new Map(); state.decided = new Set();
    computeSuggestions(); renderPreview();
  }));

  element("#reviewMatchesButton").addEventListener("click", openMatchDialog);
  element("#findOrphansButton").addEventListener("click", findOrphanPhotos);
  element("#deleteOrphansButton").addEventListener("click", deleteOrphanPhotos);
  /* change, not input: resolve once the operator has finished typing or taken a name from
     the list, rather than on every keystroke. */
  element("#matchRows").addEventListener("change", (event) => {
    const field = event.target.closest("[data-match-for]");
    if (field) chooseMatch(field.dataset.matchFor, field.value);
  });
  element("#matchRows").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-pick-for]");
    if (chip) chooseMatch(chip.dataset.pickFor, chip.dataset.pick);
  });
  /* A deliberate bulk action, not the default: it takes every top candidate including the
     ones the gate refused, which is a decision an operator is entitled to make in one go and
     the matcher is not entitled to make for them. It is recorded as their decision - the
     rows read "Chosen by you", not "Matched". */
  element("#acceptAllMatches").addEventListener("click", () => {
    const check = matchCounts().check;
    if (check && !window.confirm(`${check} of these did not clear the automatic check — most often a flavour, a strength or a pack the sheet does not name. Accept the best candidate for all of them anyway?`)) return;
    state.suggestions.forEach((entry, key) => {
      if (entry.result.top) state.matches.set(key, entry.result.top.name);
      state.decided.add(key);
    });
    state.matchNotes.clear();
    renderMatchDialog(); renderPreview();
  });
  element("#clearAllMatches").addEventListener("click", () => {
    state.suggestions.forEach((_entry, key) => { state.matches.set(key, ""); state.decided.add(key); });
    state.matchNotes.clear();
    renderMatchDialog(); renderPreview();
  });
  element("#closeMatchDialog").addEventListener("click", () => elements.matchDialog.close());
  element("#confirmMatches").addEventListener("click", () => { elements.matchDialog.close(); renderPreview(); });
  element("#importButton").addEventListener("click", importExcel);
  wireDropZone("#excelDrop", "#excelFile", readExcel);

  element("#photoFiles").addEventListener("change", (event) => readPhotoFiles(event.target.files));
  element("#uploadMatchedButton").addEventListener("click", uploadMatchedPhotos);
  wireDropZone("#photoDrop", "#photoFiles", readPhotoFiles);
  element("#applySuggestions").addEventListener("click", () => {
    syncInboxInputs();
    state.photos.forEach((photo) => { if (!photo.productName && photo.suggestions.length) photo.productName = photo.suggestions[0].product_name; });
    renderPhotoInbox();
  });
  element("#clearInbox").addEventListener("click", () => {
    state.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
    state.photos = [];
    renderPhotoInbox();
  });
  elements.photoInbox.addEventListener("click", (event) => {
    const card = event.target.closest("[data-photo-key]");
    if (!card) return;
    const suggest = event.target.closest("[data-suggest]");
    if (suggest) {
      syncInboxInputs();
      const photo = state.photos.find((item) => item.key === card.dataset.photoKey);
      if (photo) photo.productName = suggest.dataset.suggest;
      renderPhotoInbox();
      return;
    }
    if (!event.target.closest("[data-remove-photo]")) return;
    syncInboxInputs();
    const photo = state.photos.find((item) => item.key === card.dataset.photoKey);
    if (photo) URL.revokeObjectURL(photo.url);
    state.photos = state.photos.filter((item) => item.key !== card.dataset.photoKey);
    renderPhotoInbox();
  });
  elements.photoInbox.addEventListener("input", (event) => {
    if (!event.target.matches("[data-photo-product]")) return;
    const card = event.target.closest("[data-photo-key]");
    const photo = state.photos.find((item) => item.key === card?.dataset.photoKey);
    if (!photo) return;
    photo.productName = event.target.value.trim();
    const isMatched = Boolean(matchedProduct(photo.productName));
    card.classList.toggle("is-matched", isMatched);
    const badge = card.querySelector(".match-state");
    badge.className = `match-state ${isMatched ? "ok" : "no"}`;
    badge.textContent = isMatched ? "✓ Matched" : "Needs an exact product name";
    const matched = state.photos.filter((item) => matchedProduct(item.productName)).length;
    element("#uploadMatchedButton").disabled = matched === 0;
    element("#uploadMatchedButton").textContent = matched ? `Upload ${formatNumber(matched)} matched` : "Upload matched";
  });

  window.addEventListener("beforeunload", () => state.photos.forEach((photo) => URL.revokeObjectURL(photo.url)));

  (async function initialise() {
    try { if (await currentIdentity()) await showAuthenticated(); else showLogin(); }
    catch (error) { showLogin(); toast(error.message || "Admin could not start.", "error"); }
    finally { setLoading(false); }
  })();
})();
