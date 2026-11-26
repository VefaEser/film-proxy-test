# Test ortamı — ortak görsel seçimi, çok modlu analiz ve kanıt birleştirme

Bu paket yalnızca `backend_test/` ve `frontend_test/` içindir. `backend_live/` değiştirilmemiştir. Bu paket önceki `kestiktest6_gorsel_analiz_mimarisi.zip` paketinin yerine geçer; önceki paket depoya yüklenmeyecektir.

## Mimari ve veri akışı

- Kaynaklar: Crawlora IMDb still-frame, Wikimedia Commons sahne görselleri, TMDB backdrops. Wikidata P18 yalnızca dosya adı sahne karesi olduğunu işaret ediyorsa aday olur.
- Seçim: en fazla 20 sahne. Aynı URL ve benzer açıklamalar elenir; Crawlora kareleri film boyunca mümkün olduğunca dengeli örneklenir.
- Tek kaynak listesi: seçilen URL'ler `visual_samples` tablosuna `still_frame` olarak yazılır. `/images` galerisi ve `/visual/analyze` aynı kayıtları kullanır. Kayıt yazma/okuma hataları artık sessizce geçilmez.
- Turso'ya görsel binary yazılmaz. Kaynak URL/ID, kaynak adı, lisans/atıf, örneklem bilgisi ve analiz sonuçları saklanır.
- Kullanıcı galerisi: Cloud Run sunucusu Sharp ile WebP üretir. Her çıktı 20.480 baytı aşmıyorsa döndürülür; sınır sağlanamazsa orijinal gösterilmez.
- Poster, portre, logo ve tanıtım afişleri sahne analizi örneklemi değildir.

## Görsel analiz kapsamı

Görsel analiz aşağıdaki alanları üretir:

- `day_ratio`, `night_ratio`, `twilight_ratio`
- `indoor_ratio`, `outdoor_ratio`
- `color_ratio`, `black_white_ratio`, `color_style`, renk paleti
- Aydınlatma, görsel atmosfer, kamera açıları, kadraj/çekim ölçeği, kompozisyon, perspektif ve alan derinliği
- `technical_style`: mevcut filtre slug'ları (`aerial_shot` (bu tek kare örnekleminde güvenle desteklenebilen mevcut slug)) yalnızca yeterli görsel kanıt varsa

Tek bir sabit kare kamera hareketini kanıtlamaz. Ardışık kare/video hareket kanıtı bulunmadığında `handheld`, `tracking_shot`, `steadicam`, `crane_shot`, `zoom`, `pan_tilt` ve `static_camera` çıkarılmaz. Bu sürümde filtre slug'ı olarak yalnızca açıkça görülebilen havadan bakış için `aerial_shot` kullanılabilir. Kamera açısı, kadraj ve perspektif gibi doğrudan görülebilen özellikler ayrıca açıklayıcı sinematografi alanında tutulur.

Oranlar film süresinin kesin ölçümü değil, seçilmiş karelerin örneklem tahminidir. Bilinmeyen sınıflar paydaya alınmaz; `coverage`, geçerli kare sayısı ve güven değeriyle birlikte saklanır.

## Model ve yöntem zinciri

### Gemini

Görsel içerik aynı `parts`/image input ile aşağıdaki üç yöntemden geçirilir:

1. Interactions API
2. GenerateContent API
3. StreamGenerateContent API (SSE)

Modeller: `GEMINI_VISUAL_MODEL`/`GEMINI_MODEL` tercihi ve ardından kodda tanımlı Gemini model zinciri. Anahtarlar `GEMINI_API_KEY_1`, `_2`, `_3`, `GEMINI_API_KEY` sırasıyla denenir. Her istekte bütün kombinasyonların tüketilmesi zorunlu değildir; 18 deneme ve 160 saniyelik toplam süre sınırı vardır. İlk geçerli sonuçta zincir durur. Denenen/başarılı sağlayıcı, model, yöntem ve anahtar slotu (anahtar değeri değil) metadata'da tutulur.

### Groq görsel yedeği

Mevcut metin GPT-OSS modelleri görsel yedek olarak kullanılmaz. Groq'un belgelenmiş görsel modeli `qwen/qwen3.8-27b` kullanılır; API sınırı nedeniyle kareler en fazla üçlü gruplar halinde gönderilir. Anahtarlar `GROQ_API_KEY_1`, `_2`, `_3` üzerinden döndürülür. Groq yalnızca Gemini zinciri başarısız olursa çağrılır. Groq görsel model/limit bilgisi: https://console.groq.com/docs/vision

## Metin + görsel kanıtların birleştirilmesi

- Metin LLM sonuçları mevcut `movie_profiles.data_json` içinde kalır.
- Görsel sonuçlar ayrı `visual_profiles` / `visual_profile_fields` tablolarında `source_type='still_frame'` olarak kalır. Aynı adlı alanlar iki tabloda birbirini ezmez.
- Arama sırasında `research.js`, yeterli görsel örneklem varsa geçici bir filtre profili üretir. En az 8 geçerli kare, en az %55 örneklem kapsamı ve alan bazında yeterli güven aranır.
- Gündüz/gece, iç/dış ve renk oranlarında doğrudan gözlenen görsel kanıt birincildir. Metin sonucu ile görsel sonuç arasında 25 puan veya daha fazla fark varsa çatışma metadata'sı tutulur; değerler ortalanmaz.
- `technical_style` ve `color_style` için güvenilir görsel slug'ları metin slug'larına eklenir. Görsel analiz verisi kalıcı metin profiline yazılmaz; yalnızca o aramadaki filtre değerlendirmesine uygulanır.
- Yetersiz örneklem veya güven durumunda metin alanı kullanılır; görsel alan metin verisini ezmez.

## Test kurulumu

1. Paketteki `backend_test/` ve `frontend_test/` değişikliklerini test deposuna aktarın. `backend_live/` klasörüne dokunmayın.
2. Test Turso migration çalıştırıcısını kullanın: `TEST_TURSO_DATABASE_URL` ve `TEST_TURSO_AUTH_TOKEN` yalnızca test DB değerleri olacak şekilde `APPLY_MIGRATIONS=true node scripts/turso-migrate.mjs` komutunu `backend_test/` klasöründe çalıştırın. Bu paket yeni DB sütunu/migration gerektirmez; mevcut `0049_visual_still_frames.sql` halen bu görsel örneklem yapısının ön koşuludur.
3. Cloud Run test Secret/Environment bölümünde `CRAWLORA_API_KEY`, Gemini anahtarlarından en az biri ve Groq görsel yedeği isteniyorsa `GROQ_API_KEY_1` (veya `_2`, `_3`) tanımlı olmalı. Anahtarları kaynak koda yazmayın.
4. Cloud Run test servisini yeniden deploy edin.
5. Test sitesinde giriş yapıp bir film kartından **Görseller** düğmesine basın. Galeri örneklemi kaydedildikten sonra analiz aynı kareleri kullanır.

## Beklenen kontroller

- `/images` en fazla 20 kare döndürür; `visual_samples` yazma hatası olursa istek hata verir, kaydedilmemiş bir galeri başarılı gibi gösterilmez.
- Her `/image/thumbnail` yanıtı `image/webp` ve `Content-Length <= 20480` olmalı.
- `/visual/analyze` yanıtında `provider`, `model`, `method`, `analyzedSamples`, `validSamples` ve `coverage` bulunmalı.
- `visual_profile_fields` içinde `cinematography`, `day_ratio`, `night_ratio`, `indoor_ratio`, `outdoor_ratio`, `color_ratio`, `color_style`, `technical_style` ve `visual_analysis_meta` alanları oluşmalı.
- Arama filtresi yeterli örneklemde görsel değerleri kullanmalı; metin profili değerleri veritabanında değiştirilmemeli.

## Doğrulama sınırları

Yerel JavaScript sözdizimi ve arşiv bütünlüğü kontrol edilebilir. Gerçek Gemini/Groq çağrıları, Turso migration, Crawlora kaynakları, Cloud Run ve uçtan uca filtre davranışı kullanıcı test ortamında doğrulanmalıdır. Bu paket canlı servise veya canlı Turso'ya uygulanmamıştır.
