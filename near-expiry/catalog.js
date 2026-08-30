(function () {
  "use strict";

  if (!window.SNT) return;
  const { client, config, escapeHtml, queryTokens, matchesTokens, relevance, formatExpiry, expiryMeta, formatNumber,
    formatPrice, hasColumn, whatsappLink, websitePhoto, productPhoto, photoTableReady,
    initials, toast } = window.SNT;

  const LAYOUT_KEY = "snt-near-expiry-layout";
  const state = { products: [], view: "available", query: "", shelf: "all", sort: "expiry", layout: "grid", favourites: new Set(), selected: null, viewing: null, hasPrice: false, anyPrice: false, hasCompany: false, company: "all" };
  const elements = {
    grid: document.querySelector("#productGrid"), status: document.querySelector("#catalogStatus"),
    search: document.querySelector("#searchInput"), clear: document.querySelector("#clearSearch"),
    meta: document.querySelector("#resultsMeta"), shelf: document.querySelector("#shelfFilter"),
    company: document.querySelector("#companyFilter"),
    sort: document.querySelector("#sortSelect"), dialog: document.querySelector("#productDialog"),
    dialogBody: document.querySelector("#productDialogBody"), viewer: document.querySelector("#imageViewer"),
    viewerStage: document.querySelector("#viewerStage"), viewerImage: document.querySelector("#viewerImage"),
    viewerCaption: document.querySelector("#viewerCaption")
  };

  try { state.favourites = new Set(JSON.parse(localStorage.getItem(config.favouriteKey) || "[]")); } catch { state.favourites = new Set(); }
  try { state.layout = localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"; } catch { state.layout = "grid"; }

  function haystack(product) {
    return `${product.product_name} ${product.salt_name || ""} ${product.batch_no || ""} ${product.company || ""}`;
  }

  function inView(product, view) {
    return view === "favourites" ? state.favourites.has(product.id) : product.status === view;
  }

  function passesShelf(product) {
    if (state.shelf === "all") return true;
    const { months } = expiryMeta(product.expiry_date);
    return months !== null && months <= Number(state.shelf);
  }

  function sortProducts(products, tokens) {
    const compare = {
      expiry: (a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)),
      "expiry-late": (a, b) => String(b.expiry_date).localeCompare(String(a.expiry_date)),
      quantity: (a, b) => Number(b.quantity) - Number(a.quantity),
      name: (a, b) => String(a.product_name).localeCompare(String(b.product_name))
    }[state.sort] || (() => 0);
    /* A live search ranks by relevance first so the obvious match is never buried. */
    return products.sort((a, b) => (tokens.length ? relevance(b, tokens) - relevance(a, tokens) : 0) || compare(a, b) || String(a.product_name).localeCompare(String(b.product_name)));
  }

  function passesCompany(product) {
    return state.company === "all" || (product.company || "") === state.company;
  }

  function visibleProducts(tokens) {
    return sortProducts(state.products.filter((product) => inView(product, state.view) && passesShelf(product) && passesCompany(product) && matchesTokens(haystack(product), tokens)), tokens);
  }

  /* Built from the stock on the page, so a company with nothing near expiry never appears,
     and the filter empties itself when the column has not been added yet. */
  function fillCompanyFilter() {
    const companies = [...new Set(state.products.map((product) => product.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const field = document.querySelector("#companyFilterField");
    field.classList.toggle("hidden", companies.length < 2);
    if (companies.length < 2) { state.company = "all"; return; }
    elements.company.innerHTML = `<option value="all">All companies</option>${companies.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
    if (!companies.includes(state.company)) state.company = "all";
    elements.company.value = state.company;
  }

  function photoMarkup(product, className = "product-card__photo") {
    const url = productPhoto(product);
    if (!url) return `<div class="photo-placeholder"><b>${escapeHtml(initials(product.product_name))}</b><small>Photo pending</small></div>`;
    /* A photo_path can outlive the file it points at. When the upload 404s, the
       website photo takes over instead of leaving a broken frame on the card. */
    const spare = websitePhoto(product.product_name);
    return `<img class="${className}" src="${escapeHtml(url)}" alt="${escapeHtml(product.product_name)}" loading="lazy" decoding="async"${spare && spare !== url ? ` data-spare="${escapeHtml(spare)}"` : ""}>`;
  }

  /* Blank where nothing is priced at all; "on request" once the catalogue uses prices, so a
     missing figure reads as deliberate rather than as an omission. */
  function priceMarkup(product, className) {
    const price = formatPrice(product.price);
    if (price) return `<p class="${className}">${escapeHtml(price)}</p>`;
    return state.anyPrice ? `<p class="${className} is-unpriced">On request</p>` : `<p class="${className}"></p>`;
  }

  const shareIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.5 14.1c-.2.6-1.2 1.2-1.7 1.2-.5.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.6a11 11 0 0 1-4.2-3.8c-.3-.5-.7-1.1-.7-1.8 0-.7.3-1.1.5-1.3.2-.2.4-.3.6-.3h.4c.1 0 .3 0 .5.4l.6 1.5c0 .1.1.2 0 .4l-.3.4-.2.3c-.1.1-.2.2 0 .4.2.3.6 1 1.3 1.6.9.8 1.6 1 1.9 1.1.2.1.4.1.5-.1l.6-.7c.2-.2.3-.2.5-.1l1.5.7c.2.1.4.2.4.3.1.1.1.4 0 .5Z"/></svg>';

  function productCard(product) {
    const saved = state.favourites.has(product.id);
    const shelf = expiryMeta(product.expiry_date);
    const urgent = ["critical", "expired"].includes(shelf.tone) ? shelf.tone : shelf.tone === "soon" ? "soon" : "";
    return `<article class="product-card ${product.status === "sold" ? "is-sold" : ""}" data-product-id="${escapeHtml(product.id)}" tabindex="0" role="button" aria-label="${escapeHtml(product.product_name)}">
      <div class="product-card__visual">${photoMarkup(product)}
        <div class="card-tags">${product.status === "sold" ? '<span class="tag tag--sold">Sold</span>' : ""}${urgent && product.status !== "sold" ? `<span class="tag tag--${urgent}">${escapeHtml(shelf.label)}</span>` : ""}</div>
      </div>
      <div class="product-card__content">
        <div class="list-main">
          ${product.company ? `<p class="product-card__company">${escapeHtml(product.company)}</p>` : ""}
          <h2>${escapeHtml(product.product_name)}</h2>
          <p class="product-card__salt">${escapeHtml(product.salt_name || "Composition not listed")}</p>
        </div>
        ${priceMarkup(product, "card-price")}
        <div class="card-figures">
          <div class="figure"><small>Expiry</small><strong class="figure__exp">${formatExpiry(product.expiry_date)}</strong></div>
          <div class="figure figure--right"><small>Quantity</small><strong>${formatNumber(product.quantity)}</strong></div>
        </div>
        <div class="card-footer">
          <span class="shelf shelf--${shelf.tone}">${escapeHtml(shelf.label)}</span>
          <button class="share-mini" type="button" data-share="${escapeHtml(product.id)}" aria-label="Share ${escapeHtml(product.product_name)}">${shareIcon} Share</button>
          <button class="favourite-button ${saved ? "is-saved" : ""}" type="button" data-favourite="${escapeHtml(product.id)}" aria-pressed="${saved}" aria-label="${saved ? "Remove from" : "Add to"} saved">${saved ? "♥" : "♡"}</button>
        </div>
      </div>
    </article>`;
  }

  /* The tab counters already state how much stock there is. This line only earns its space
     when a search or filter is hiding some of it, or when a match sits under another tab. */
  function renderMeta(products, tokens) {
    /* The company filter narrows as surely as the other two, and without it here the tab
       would read 175 over a grid showing two. */
    const narrowed = tokens.length || state.shelf !== "all" || state.company !== "all";
    const parts = [];
    if (narrowed) {
      const total = state.products.filter((product) => inView(product, state.view)).length;
      parts.push(`<strong>${formatNumber(products.length)}</strong> of ${formatNumber(total)}`);
    }
    if (tokens.length) {
      ["available", "sold"].filter((view) => view !== state.view).forEach((view) => {
        /* Counted under the same company filter, or the offer to look in the other tab
           promises stock that tab would not show either. */
        const elsewhere = state.products.filter((product) => inView(product, view) && passesCompany(product) && matchesTokens(haystack(product), tokens)).length;
        if (elsewhere) parts.push(`<button class="cross-hint" type="button" data-view="${view}">${formatNumber(elsewhere)} more in ${view}</button>`);
      });
    }
    elements.meta.innerHTML = parts.join(" ");
    elements.meta.hidden = parts.length === 0;
  }

  function render() {
    const counts = {
      available: state.products.filter((product) => product.status === "available").length,
      sold: state.products.filter((product) => product.status === "sold").length,
      saved: state.products.filter((product) => state.favourites.has(product.id)).length
    };
    document.querySelector("#availableTabCount").textContent = counts.available;
    document.querySelector("#soldTabCount").textContent = counts.sold;
    document.querySelector("#savedTabCount").textContent = counts.saved;
    document.querySelectorAll(".segmented [data-view]").forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-layout]").forEach((button) => button.classList.toggle("is-active", button.dataset.layout === state.layout));
    elements.clear.classList.toggle("is-visible", Boolean(state.query));
    elements.grid.classList.toggle("is-list", state.layout === "list");

    const tokens = queryTokens(state.query);
    const products = visibleProducts(tokens);
    elements.status.hidden = true;
    renderMeta(products, tokens);
    if (!products.length) {
      elements.grid.classList.remove("is-list");
      elements.grid.innerHTML = document.querySelector("#emptyTemplate").innerHTML;
      const detail = elements.grid.querySelector("#emptyDetail");
      if (detail && state.view === "favourites" && !tokens.length) detail.textContent = "Tap the heart on any product to build a shortlist you can share later.";
      return;
    }
    elements.grid.innerHTML = products.map(productCard).join("");
  }

  function findProduct(id) {
    return state.products.find((product) => product.id === id) || null;
  }

  function toggleFavourite(id) {
    if (state.favourites.has(id)) state.favourites.delete(id); else state.favourites.add(id);
    try { localStorage.setItem(config.favouriteKey, JSON.stringify([...state.favourites])); } catch { /* private mode — keep the in-memory list */ }
    render();
    if (state.selected?.id === id) openProduct(state.selected, false);
  }

  function shareText(product, url) {
    const shelf = expiryMeta(product.expiry_date);
    return [
      `*${product.product_name}*`,
      product.company ? `Company: ${product.company}` : "",
      product.salt_name ? `Salt: ${product.salt_name}` : "",
      `Expiry: ${formatExpiry(product.expiry_date)}${shelf.months === null ? "" : ` (${shelf.label})`}`,
      `Quantity: ${formatNumber(product.quantity)}`,
      formatPrice(product.price) ? `Price: ${formatPrice(product.price)}` : state.anyPrice ? "Price: on request" : "",
      product.batch_no ? `Batch: ${product.batch_no}` : "",
      `Status: ${product.status}`,
      "",
      `View on SNT Near Expiry: ${url}`
    ].filter(Boolean).join("\n");
  }

  async function shareProduct(product) {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("product", product.id);
    const text = shareText(product, url.toString());
    const imageUrl = productPhoto(product);
    try {
      if (imageUrl && navigator.share) {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error("Photo unavailable");
        const blob = await response.blob();
        const extension = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const file = new File([blob], `${product.product_name}.${extension}`, { type: blob.type });
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          await navigator.share({ title: product.product_name, text, files: [file] });
          return;
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
    /* No recipient: this opens WhatsApp's contact picker so the viewer forwards it on. */
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  }

  function openProduct(product, updateUrl = true) {
    if (!product) return;
    state.selected = product;
    const saved = state.favourites.has(product.id);
    const shelf = expiryMeta(product.expiry_date);
    const hasPhoto = Boolean(productPhoto(product));
    elements.dialogBody.innerHTML = `<div class="dialog-photo${hasPhoto ? " is-zoomable" : ""}"${hasPhoto ? ' role="button" tabindex="0" aria-label="View full-size photo" data-open-photo' : ""}>${photoMarkup(product, "dialog-photo__image")}${hasPhoto ? '<span class="photo-expand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path></svg> Tap to enlarge</span>' : ""}</div>
      <div class="dialog-content">
        ${product.company ? `<p class="dialog-company">${escapeHtml(product.company)}</p>` : ""}
        <h2>${escapeHtml(product.product_name)}</h2>
        <p class="dialog-salt">${escapeHtml(product.salt_name || "Composition not listed")}</p>
        <div class="dialog-chips">
          <span class="shelf shelf--${shelf.tone}">${escapeHtml(shelf.label)}</span>
          ${product.status === "sold" ? '<span class="chip">Sold out</span>' : '<span class="chip">Available</span>'}
          ${product.batch_no ? `<span class="chip">Batch ${escapeHtml(product.batch_no)}</span>` : ""}
        </div>
        <div class="detail-pair${state.anyPrice ? " detail-pair--three" : ""}">
          <div><small>Expiry</small><strong class="figure__exp">${formatExpiry(product.expiry_date)}</strong></div>
          <div><small>Quantity</small><strong>${formatNumber(product.quantity)}</strong></div>
          ${state.anyPrice ? `<div><small>Price</small><strong class="figure__price">${escapeHtml(formatPrice(product.price)) || "On request"}</strong></div>` : ""}
        </div>
        <div class="dialog-actions">
          <button class="primary-button whatsapp-button" type="button" data-share-product>${shareIcon} Share photo &amp; details</button>
          <button class="secondary-button" type="button" data-favourite="${escapeHtml(product.id)}">${saved ? "♥ Saved" : "♡ Save to shortlist"}</button>
        </div>
        <p class="fine-print">On supported phones the original photo is shared along with the details. Availability is confirmed by SNT at the time of order.</p>
      </div>`;
    elements.dialogBody.querySelector("[data-share-product]").addEventListener("click", () => shareProduct(product));
    elements.dialogBody.querySelector("[data-favourite]").addEventListener("click", () => toggleFavourite(product.id));
    const photoTrigger = elements.dialogBody.querySelector("[data-open-photo]");
    if (photoTrigger) {
      photoTrigger.addEventListener("click", () => openViewer(product));
      photoTrigger.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openViewer(product);
      });
    }
    if (!elements.dialog.open) elements.dialog.showModal();
    if (updateUrl) {
      const url = new URL(window.location.href); url.searchParams.set("product", product.id); history.replaceState({}, "", url);
    }
  }

  /* ---- full-size photo viewer -------------------------------------------
     Chemists forward these photos into WhatsApp all day, so the viewer's real job
     is handing over the original image file, not just showing it bigger. */

  function openViewer(product) {
    const url = productPhoto(product);
    if (!url) return;
    state.viewing = product;
    elements.viewerImage.src = url;
    elements.viewerImage.alt = product.product_name;
    elements.viewerCaption.textContent = product.product_name;
    elements.viewerStage.classList.remove("is-zoomed");
    if (!elements.viewer.open) elements.viewer.showModal();
  }

  function closeViewer() {
    if (elements.viewer.open) elements.viewer.close();
    state.viewing = null;
    elements.viewerImage.removeAttribute("src");
  }

  /* The clipboard only accepts PNG, so anything else is repainted through a canvas. */
  async function asPngBlob(blob) {
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("Image could not be converted.");
    return png;
  }

  async function downloadPhoto() {
    const product = state.viewing;
    if (!product) return;
    try {
      const blob = await fetch(productPhoto(product)).then((response) => response.blob());
      const extension = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${product.product_name.replace(/[^\w\d]+/g, "-").replace(/^-|-$/g, "")}.${extension}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
    } catch { toast("The photo could not be saved.", "error"); }
  }

  function copyPhoto() {
    const product = state.viewing;
    if (!product) return;
    /* Safari only honours a clipboard write started inside the click itself, so the
       promise has to be handed to ClipboardItem rather than awaited first. */
    const supported = Boolean(window.ClipboardItem && navigator.clipboard?.write);
    if (!supported) {
      toast("This browser cannot copy images — saving it instead.", "warning");
      downloadPhoto();
      return;
    }
    const png = fetch(productPhoto(product)).then((response) => response.blob()).then(asPngBlob);
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
      .then(() => toast("Photo copied — paste it straight into WhatsApp."))
      .catch(() => { toast("Could not copy the photo — saving it instead.", "warning"); downloadPhoto(); });
  }

  function closeDialog() {
    if (elements.dialog.open) elements.dialog.close();
    state.selected = null;
    const url = new URL(window.location.href); url.searchParams.delete("product"); history.replaceState({}, "", url);
  }

  function showSkeleton() {
    elements.status.hidden = true;
    elements.grid.classList.add("skeleton-grid");
    elements.grid.innerHTML = Array.from({ length: 10 }, () => '<div class="skeleton"></div>').join("");
  }

  async function loadProducts() {
    showSkeleton();
    [state.hasPrice, state.hasCompany] = await Promise.all([hasColumn("price"), hasColumn("company")]);
    const columns = `id,product_name,salt_name,batch_no,expiry_date,quantity,photo_path,status,updated_at${state.hasPrice ? ",price" : ""}${state.hasCompany ? ",company" : ""}`;
    const { data, error } = await client.from("near_expiry_items")
      .select(columns)
      .order("status", { ascending: true }).order("expiry_date", { ascending: true }).order("product_name", { ascending: true });
    if (error) throw error;
    await photoTableReady;
    elements.grid.classList.remove("skeleton-grid");
    state.products = data || [];
    state.anyPrice = state.products.some((product) => formatPrice(product.price));
    fillCompanyFilter();
    const latest = state.products.reduce((newest, product) => (product.updated_at > newest ? product.updated_at : newest), "");
    if (latest) {
      const date = new Date(latest);
      if (!Number.isNaN(date.getTime())) document.querySelector("#updatedLine").textContent = `Updated ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date)}`;
    }
    render();
    openProduct(findProduct(new URLSearchParams(location.search).get("product")), false);
  }

  document.querySelectorAll("[data-whatsapp-link]").forEach((link) => { link.href = whatsappLink(); });

  elements.search.addEventListener("input", (event) => { state.query = event.target.value; render(); });
  elements.search.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.query) { event.stopPropagation(); state.query = ""; event.target.value = ""; render(); } });
  elements.clear.addEventListener("click", () => { state.query = ""; elements.search.value = ""; elements.search.focus(); render(); });
  elements.shelf.addEventListener("change", (event) => { state.shelf = event.target.value; render(); });
  elements.company.addEventListener("change", (event) => { state.company = event.target.value; render(); });
  elements.sort.addEventListener("change", (event) => { state.sort = event.target.value; render(); });
  document.querySelector(".layout-toggle").addEventListener("click", (event) => {
    const button = event.target.closest("[data-layout]");
    if (!button) return;
    state.layout = button.dataset.layout;
    try { localStorage.setItem(LAYOUT_KEY, state.layout); } catch { /* ignore */ }
    render();
  });
  document.body.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-view]");
    if (!tab) return;
    state.view = tab.dataset.view;
    render();
    window.scrollTo({ top: document.querySelector(".toolbar").offsetTop - 80, behavior: "smooth" });
  });
  elements.grid.addEventListener("click", (event) => {
    if (event.target.closest("[data-reset-filters]")) {
      state.query = ""; state.shelf = "all"; elements.search.value = ""; elements.shelf.value = "all"; render(); return;
    }
    const favourite = event.target.closest("[data-favourite]");
    if (favourite) { event.stopPropagation(); toggleFavourite(favourite.dataset.favourite); return; }
    const share = event.target.closest("[data-share]");
    if (share) { event.stopPropagation(); shareProduct(findProduct(share.dataset.share) || {}); return; }
    const card = event.target.closest("[data-product-id]");
    if (card) openProduct(findProduct(card.dataset.productId));
  });
  elements.grid.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-product-id]");
    if (!card) return;
    event.preventDefault();
    openProduct(findProduct(card.dataset.productId));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    event.preventDefault();
    elements.search.focus();
    elements.search.select();
  });
  elements.viewer.addEventListener("click", (event) => {
    if (event.target.closest("[data-copy-image]")) return copyPhoto();
    if (event.target.closest("[data-download-image]")) return downloadPhoto();
    if (event.target.closest("[data-close-viewer]") || event.target === elements.viewer) return closeViewer();
    if (event.target === elements.viewerImage) elements.viewerStage.classList.toggle("is-zoomed");
  });
  /* Image errors do not bubble, so this has to listen on the way down. */
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.dataset.spare) return;
    const spare = image.dataset.spare;
    delete image.dataset.spare;
    image.src = spare;
  }, true);

  elements.viewer.addEventListener("cancel", (event) => { event.preventDefault(); closeViewer(); });
  document.querySelector("[data-close-dialog]").addEventListener("click", closeDialog);
  elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) closeDialog(); });
  elements.dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });

  loadProducts().catch((error) => {
    elements.grid.classList.remove("skeleton-grid");
    elements.grid.innerHTML = "";
    elements.meta.textContent = "";
    elements.status.hidden = false;
    elements.status.classList.add("catalog-status--error");
    elements.status.innerHTML = `<strong>The catalogue could not load.</strong><br>${escapeHtml(error.message || "Please check your connection and reload the page.")}`;
    toast("Could not load the catalogue.", "error");
  });
})();
