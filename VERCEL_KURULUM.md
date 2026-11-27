# film-proxy-test — Vercel test backend

Bu paket yalnızca TEST ortamı içindir. Canlı `film-proxy` projesine yüklemeyin.

## Mimari notu
- Bu arşivdeki HF test ön yüzünde `API_BASE`, `https://film-proxy-test.vercel.app` olarak ayarlıdır. Normal film/API istekleri ve admin oturumu Vercel `api/[...path].js` fonksiyonundan geçer.
- Vercel Node.js fonksiyonu `@libsql/client/node` adaptörünü kullanır. Cloudflare test Worker ise kendi Worker girişinde `@libsql/client/web` adaptörünü kullanır. İki ortam da yalnızca `TEST_TURSO_DATABASE_URL` ve `TEST_TURSO_AUTH_TOKEN` değerlerini kullanır.
- Test Cloudflare Worker Cron, dakikada bir Vercel üzerindeki gizli görev uç noktasını çağırır.

## İçerik ve sınırlar
- V5.5 GitHub-test backend kaynakları ve migrations klasörü.
- Vercel Node.js catch-all adaptörü (`api/[...path].js`).
- Test Turso seçimi `index.js` içinde zorunlu tutulur; canlı Turso'ya fallback yoktur.
- `/image/thumbnail` Node + Sharp ile çalışır ve 20 KB WebP sınırını uygular.
- `/internal/run-admin-tasks` yalnızca `TASK_RUNNER_SECRET` Bearer doğrulamasıyla erişilebilir.
- Cloudflare test Worker Cron dakikada bir Vercel endpoint'ini çağırır; her çağrı en çok 5 kuyruk öğesi işler.

## GitHub test deposuna yükleme
Arşivin içindeki dosyaları `film-proxy-test` deposunun kök dizinine yerleştirin. Mevcut V5.5 backend dosyaları bu pakette tam olarak bulunur. HF frontend dosyaları bu pakete dahil değildir; HF'de mevcut frontend'i değiştirmeyin.

## Vercel
- Framework: Other (Node.js fonksiyonları otomatik algılanır); Root Directory: `.`
- Node.js 22 kullanın.
- Önce Settings → Environment Variables bölümüne aşağıdaki TEST değişkenlerini ekleyin:
  - `TEST_TURSO_DATABASE_URL`
  - `TEST_TURSO_AUTH_TOKEN`
  - V5.5 backend'in ihtiyaç duyduğu test API anahtarları (TMDB, OMDb, Gemini/Groq vb. yalnızca test anahtarları)
  - `TASK_RUNNER_SECRET` (en az 32 karakter rastgele değer)
- `TURSO_DATABASE_URL` veya `TURSO_AUTH_TOKEN` canlı değerlerini eklemeyin.
- Deploy işleminden sonra Vercel alan adını kaydedin.

## Cloudflare test Worker
Mevcut test Worker `film-api-proxy` için:
- `VERCEL_TASK_RUNNER_URL` = `https://<vercel-proje-alanı>/internal/run-admin-tasks`
- `TASK_RUNNER_SECRET` = Vercel'deki aynı gizli değer (Secret olarak)
- `wrangler.json` içindeki `* * * * *` Cron korunmalıdır.
- Bu değişiklikler canlı `film-proxy` Worker'ına uygulanmamalıdır.

## CSV ve toplu görev davranışı
- Kuyruğa başarıyla yazılmış toplu kart/liste görevleri tarayıcı kapansa da Turso'da kalır ve Cron çağrılarıyla sürer.
- CSV'nin tarayıcıdan henüz yüklenmemiş parçaları sunucuda bulunmaz. Aktarımın kendisi tamamlanmadan sekme kapanırsa, mevcut devam ettirme akışıyla CSV yeniden seçilerek aktarım sürdürülmelidir.
- Vercel Hobby fonksiyon sınırı nedeniyle her tetikleme en fazla 5 öğe işler; bu sınırsız veya anlık çalışma garantisi değildir. Cron dakikada bir çalışır.

## Doğrulama notu
Bu paket için yerel sözdizimi ve JSON kontrolleri yapılmıştır. Gerçek Vercel deploy, Vercel ortam değişkenleri ve canlı test Turso bağlantısı bu çalışma ortamından doğrulanamaz. İlk Deploy öncesi test DB migration durumunun V5.5 ile uyumlu olduğundan emin olun.
