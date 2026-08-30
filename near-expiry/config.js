window.SNT_CONFIG = Object.freeze({
  supabaseUrl: "https://sfrfjznzlrkofjddfzfh.supabase.co",
  supabasePublishableKey: "sb_publishable_nbPPdoNse5zY7_pr7HFxQQ_7jBaoKO0",
  photoBucket: "near-expiry-photos",
  /* Read-only fallback: the main site's photo folder, and the lookup table that
     tools/build-photo-map.py generates from its data.js. Both sit one level up
     because this app is served from /near-expiry/. */
  websitePhotos: "../Photos/",
  websitePhotoMap: "photo-map.json",
  favouriteKey: "snt-near-expiry-favourites-v2",
  /* Country code first, digits only — this is the number the public catalogue links to. */
  whatsappNumber: "919304818900",
  whatsappLabel: "WhatsApp SNT",
  currency: "₹"
});
