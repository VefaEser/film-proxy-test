# Kestiktest6 — Crawlora görsel kaynağı entegrasyonu (ilk test paketi)

## Kaynak dosya önceliği
1. `kestiktest6.zip`
2. Üzerine `kestiktest6_degisen_dosyalar.zip`
3. En son `kestiktest6_guncel_degisiklikler_2026-11-26.zip`

Bu paket yalnızca değişen/yeni dosyaları içerir. Hedef: `film_kesif_kaynak_toplama/` dizin kökü.

## Değişen dosyalar
- `backend_test/crawlora-images.js` (yeni): Crawlora IMDb `still_frame` API adaptörü. `CRAWLORA_API_KEY` secret'ını okur, 1000 limitini kullanır, görselleri indirmez; URL ve metadata döndürür. IMDb ID başına 6 saatlik süreç içi önbellek vardır.
- `backend_test/sources.js`: `/images` akışına Crawlora kaynağını ekler. Öncelik sırası Crawlora still-frame → TMDB backdrop → Wikimedia Commons. Mevcut kaynak hataları birbirinden izole edilmiştir.
- `frontend_test/app-render.js`: Görsel isteğine film kartındaki IMDb ID'yi ekler; görsel öğelerinde kaynak türünü data attribute/title olarak taşır.

## Secret
Cloud Run test servisine `CRAWLORA_API_KEY` adıyla secret/env değişkeni eklenmelidir. `server.js` `process.env` ortamını Worker'a aktardığı için ek bir kod değişikliği gerekmez. Anahtar frontend'e, ZIP'e veya Git deposuna konulmamalıdır.

## Şimdiki kapsam ve bilinçli sınır
Bu paket Crawlora görsellerini mevcut galeriye getirir ve TMDB/Commons kaynaklarını korur. Henüz Gemini'ye görsel göndermez, 471 kare içinden sinematografik çeşitlilik algoritmasıyla 20 kare seçmez ve `visual_profiles` tablolarına analiz yazmaz. Bu aşamaları aynı pakette tamamlanmış gibi göstermemek için ayrı bıraktım. Önce test ortamında gerçek Crawlora yanıt şeması, IMDb ID'nin frontend film nesnelerinde bulunması, çağrı maliyeti ve görsel erişimi doğrulanmalıdır. Sonraki paket; görsel ön eleme/çeşitlilik seçimi, Gemini multimodal çağrısı, token ölçümü ve mevcut görsel profil önbelleğine yazmayı kapsayacaktır.

## Kontroller
- `node --check backend_test/crawlora-images.js`
- `node --check backend_test/sources.js`
- `node --check frontend_test/app-render.js`

Bu paket canlı backend'e, canlı veritabanına veya uzak dağıtıma uygulanmamıştır. Migration içermez.
