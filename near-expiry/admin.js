(function () {
  "use strict";

  if (!window.SNT) return;
  const { client, config, escapeHtml, normalise, searchable, queryTokens, matchesTokens, parseExpiry, formatExpiry,
    expiryForInput, expiryMeta, formatNumber, formatPrice, parsePrice, hasColumn, photoUrl,
    websitePhoto, photoTableReady, toast } = window.SNT;

  const CHUNK = 100;
  const PREVIEW_ROWS = 60;
  const state = {
    user: null, role: "operator", products: [], master: [],
    workbookRows: [], rawRows: [], headers: [], parsed: [], editing: null, photos: [], hasPrice: false, hasCompany: false,
    /* ids whose delete is still in flight, so a double-click cannot fire two */
    removing: new Set(), deletingAll: null
  };
  const element = (selector) => document.querySelector(selector);
  const elements = {
    loginView: element("#loginView"), adminView: element("#adminView"), loading: element("#loadingOverlay"),
    rows: element("#inventoryRows"), search: element("#adminSearch"), statusFilter: element("#adminStatusFilter"),
    formDialog: element("#productFormDialog"), deleteAllDialog: element("#deleteAllDialog"), photoInbox: element("#photoInbox")
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
     feature is switched on only once its column is really there. */
  async function applyOptionalColumns() {
    [state.hasPrice, state.hasCompany] = await Promise.all([hasColumn("price"), hasColumn("company")]);
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
    await applyOptionalColumns();
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
    const { error: updateError } = await client.from("near_expiry_items").update({ photo_path: path, updated_by: state.user.id }).eq("id", product.id);
    if (updateError) {
      await client.storage.from(config.photoBucket).remove([path]);
      throw updateError;
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
    const { error } = await client.from("near_expiry_items").update({ status, updated_by: state.user.id }).eq("id", product.id);
    if (error) return toast(error.message, "error");
    product.status = status; renderInventory(); toast(`Marked ${status}.`);
  }

  function permissionMessage(error) {
    return /permission|denied|row-level|policy|42501/i.test(`${error?.code || ""} ${error?.message || ""}`)
      ? "Your account is not allowed to delete products. Ask an SNT admin to grant it in Supabase."
      : error?.message || "Product could not be deleted.";
  }

  /* Deleting is immediate and optimistic: the row leaves the table on the click and the
     database catches up behind it. Sold-out stock is cleared in runs, and a confirmation
     plus a full reload between each one made that a chore. The row going is the receipt,
     so a success toast would only be noise; a refusal puts the row back where it was and
     says why. */
  async function deleteProduct(product) {
    if (!product || state.removing.has(product.id)) return;
    state.removing.add(product.id);
    const position = state.products.indexOf(product);
    state.products.splice(position, 1);
    renderInventory();
    try {
      const { error } = await client.from("near_expiry_items").delete().eq("id", product.id);
      if (error) throw error;
      /* The row is gone, so the product is deleted whatever happens next. A photo left behind
         in storage is worth a warning, not a failure the operator has to act on. */
      if (product.photo_path) {
        const { error: storageError } = await client.storage.from(config.photoBucket).remove([product.photo_path]);
        if (storageError) toast(`${product.product_name} was deleted, but its photo is still in storage.`, "warning");
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
    const photos = doomed.map((item) => item.photo_path).filter(Boolean);
    setLoading(true, `Deleting ${formatNumber(ids.length)} products…`);
    try {
      for (let start = 0; start < ids.length; start += CHUNK) {
        const chunk = ids.slice(start, start + CHUNK);
        const { error } = await client.from("near_expiry_items").delete().in("id", chunk);
        if (error) throw error;
        setLoading(true, `Deleted ${formatNumber(start + chunk.length)} of ${formatNumber(ids.length)}…`);
      }
      let photosRemoved = true;
      for (let start = 0; start < photos.length; start += CHUNK) {
        const { error } = await client.storage.from(config.photoBucket).remove(photos.slice(start, start + CHUNK));
        if (error) photosRemoved = false;
      }
      await loadProducts();
      if (photosRemoved) toast(`${formatNumber(ids.length)} products deleted.`);
      else toast(`${formatNumber(ids.length)} products deleted, but some photos are still in storage.`, "warning");
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

  function detectHeader(patterns) {
    return state.headers.find((header) => patterns.some((pattern) => pattern.test(header.trim().toLowerCase()))) || "";
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
    const lookup = new Map(state.master.map((item) => [normalise(item.name), item]));
    state.parsed = state.workbookRows.map((row, index) => {
      const rawRow = state.rawRows[index] || {};
      const name = String(row[mapping.product] ?? "").trim();
      const rawExpiry = mapping.expiry ? row[mapping.expiry] : "";
      const expiry = excelExpiry(rawExpiry, mapping.expiry ? rawRow[mapping.expiry] : "");
      const batch = mapping.batch ? String(row[mapping.batch] ?? "").trim() : "";
      const quantity = Math.max(0, Math.trunc(Number(String(row[mapping.quantity] ?? "").replace(/[,\s]/g, "")) || 0));
      const salt = (mapping.salt ? String(row[mapping.salt] ?? "").trim() : "") || lookup.get(normalise(name))?.salt || "";
      /* Most sheets carry no company column, and the master already knows it for every
         catalogue product — so an unmapped company is looked up rather than left blank. */
      const company = (mapping.company ? String(row[mapping.company] ?? "").trim() : "") || lookup.get(normalise(name))?.company || "";
      const rawPrice = mapping.price ? row[mapping.price] : "";
      const price = parsePrice(rawPrice);
      const problems = [];
      if (!name) problems.push("no product name");
      if (!expiry) problems.push(`expiry "${String(rawExpiry ?? "").trim() || "blank"}" not understood`);
      /* An unreadable price is a warning, not a reason to drop a whole product row. */
      const warnings = mapping.price && String(rawPrice ?? "").trim() && price === null
        ? [`price "${String(rawPrice).trim()}" not understood — imported without a price`] : [];
      return { line: index + 2, name, salt, company, batch, quantity, expiry, rawExpiry, price, problems, warnings };
    });
    return state.parsed;
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
    const unique = new Map(valid.map((row) => [`${normalise(row.name)}|${normalise(row.batch)}|${row.expiry}`, row]));
    const duplicates = valid.length - unique.size;
    const zeroQuantity = [...unique.values()].filter((row) => row.quantity <= 0).length;
    const priceWarnings = valid.filter((row) => row.warnings.length).length;

    summary.innerHTML = [
      `<span class="ok">${formatNumber(unique.size)} ready to import</span>`,
      duplicates ? `<span class="warn">${formatNumber(duplicates)} duplicate rows merged</span>` : "",
      zeroQuantity ? `<span class="warn">${formatNumber(zeroQuantity)} with quantity 0 → marked sold</span>` : "",
      priceWarnings ? `<span class="warn">${formatNumber(priceWarnings)} with an unreadable price</span>` : "",
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
    element("#importButton").disabled = unique.size === 0;
    element("#importButton").textContent = `Import ${formatNumber(unique.size)} products`;
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
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      /* Two views of the same sheet: cells as they read on screen, and the underlying
         values, so a genuine date cell still resolves when its text is ambiguous. */
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
      if (!rows.length) throw new Error("The first worksheet has no data rows.");
      state.workbookRows = rows;
      state.rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
      /* Union of keys — the first row alone misses columns that start out blank. */
      state.headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const selected = {
        product: detectHeader([/^product( name)?s?$/, /^item( name)?$/, /^brand( name)?$/, /product/]),
        salt: detectHeader([/salt/, /composition/, /generic/]),
        expiry: detectHeader([/^exp$/, /expiry/, /expiration/, /^exp\b/]),
        quantity: detectHeader([/^qty$/, /quantity/, /stock/, /^pcs$/]),
        batch: detectHeader([/batch/, /^b\.?no\.?$/, /lot/]),
        price: detectHeader([/^price$/, /^rate$/, /^mrp$/, /^ptr$/, /^pts$/, /price/, /rate/]),
        company: detectHeader([/^company$/, /^companies$/, /^mfr$/, /manufacturer/, /^brand$/, /^division$/, /^supplier$/, /company/])
      };
      element("#mapProduct").innerHTML = columnOptions(selected.product);
      element("#mapSalt").innerHTML = columnOptions(selected.salt, true);
      element("#mapExpiry").innerHTML = columnOptions(selected.expiry);
      element("#mapQuantity").innerHTML = columnOptions(selected.quantity);
      element("#mapBatch").innerHTML = columnOptions(selected.batch, true);
      element("#mapPrice").innerHTML = columnOptions(selected.price, true);
      element("#mapCompany").innerHTML = columnOptions(selected.company, true);
      element("#excelFileStatus").textContent = `${file.name} · ${formatNumber(rows.length)} rows`;
      renderPreview();
    } catch (error) { toast(error.message || "Spreadsheet could not be read.", "error"); }
    finally { setLoading(false); }
  }

  async function importExcel() {
    const parsed = state.parsed.filter((row) => !row.problems.length);
    if (!parsed.length) return toast("There are no valid rows to import.", "error");
    const mapping = currentMapping();
    const keepSold = element("#keepSoldStatus").checked;
    const existing = new Map(state.products.map((item) => [`${normalise(item.product_name)}|${normalise(item.batch_no)}|${item.expiry_date}`, item]));

    const unique = new Map();
    parsed.forEach((row) => {
      const key = `${normalise(row.name)}|${normalise(row.batch)}|${row.expiry}`;
      const current = existing.get(key);
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
  ["#mapProduct", "#mapSalt", "#mapExpiry", "#mapQuantity", "#mapBatch", "#mapPrice", "#mapCompany"].forEach((id) => element(id).addEventListener("change", renderPreview));
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
