# TEST DEPOSU YAMA NOTLARI

Bu yama yalnızca `VefaEser/film-proxy-test` deposu içindir. Canlı `film-proxy`, canlı Worker ve hiçbir Turso veritabanına işlem yapılmamıştır.

## ZIP incelemesinden doğrulanan bulgular

1. Hugging Face test ön yüzündeki `app-defs.js` dosyasında `API_BASE` değeri `https://film-proxy-test.vercel.app`.
2. `appadmin.js`, admin token'ını `GET /auth/me` isteğinde Bearer olarak gönderiyor; başarılı yanıtta HttpOnly oturum çerezi bekliyor.
3. Test ortamında `index.js`, `IS_TEST_ENV` değerini boolean `true` yapıyor. `auth.js` bu durumda `sid_test` çerez adını kullanıyor.
4. `/admin/ping` endpoint'i `index.js` içinde mevcut. Admin route dispatch koşulu `/admin/ping` yolunu `admin.js`'e yönlendirmiyor; bu nedenle `index.js` içindeki endpoint'e ulaşabiliyor. `admin.js` içinde ayrıca ping handler bulunmaması tek başına hata değil.
5. `turso-adapter.js` `@libsql/client/web` kullanıyor. Aynı Worker giriş dosyası Vercel Node fonksiyonundan da çağrıldığı için çalışma ortamına göre istemci ayrımı gerekli.

## Yamada yapılan değişiklikler

- `turso-adapter-core.js` (YENİ): Turso adapter'ın ortak SQL/sonuç dönüştürme kodu.
- `turso-adapter.js`: Cloudflare Worker için `@libsql/client/web` kullanır.
- `turso-adapter-node.js` (YENİ): Vercel/Node için `@libsql/client/node` kullanır.
- `index.js`: Worker adaptörünü yalnızca DB nesnesi giriş noktasından enjekte edilmemişse dinamik yükler. Vercel/Node tarafından verilen DB nesnesini ezmez.
- `api/[...path].js`: Node adapter'ını enjekte eder ve geçici `GET /__echo` tanılama yolunu ekler. Echo; isteğin fonksiyona gelen URL/path değerlerini ve yalnızca ortam değişkenlerinin mevcut olup olmadığını gösterir. Gizli değerleri döndürmez; Worker veya DB çağırmaz.
- `server.js`: Cloud Run/Node girişinde de Node adapter'ını enjekte eder.
- `VERCEL_TEST_NOTES.md` ve `VERCEL_KURULUM.md`: Mimari açıklamaları mevcut ön yüz API_BASE ayarıyla uyumlu hâle getirildi.

## Bilinçli olarak değiştirilmedi

- HF ön yüzündeki `API_BASE` zaten test Vercel adresini gösteriyor; değiştirilmedi.
- `/admin/ping` endpoint'i zaten var; yeni veya mükerrer endpoint eklenmedi.
- Cookie adı ve admin token doğrulama akışı değiştirilmedi.
- `vercel.json` rewrite ayarı değiştirilmedi. Önce `/__echo` çıktısıyla gerçek davranış görülmeli.
- `package.json` sürümü değiştirilmedi. `@libsql/client` 0.18.x paketi Node alt modülünü de sağlar.

## Uygulama sırası

1. ZIP içindeki dosyaları GitHub test deposunun köküne, klasör yollarını koruyarak kopyala.
2. `api/[...path].js`, `index.js`, `server.js`, `turso-adapter.js` dosyalarını değiştir; `turso-adapter-core.js` ve `turso-adapter-node.js` dosyalarını ekle.
3. İki Markdown kurulum notunu güncelle.
4. `main` dalına gönder ve Vercel test projesinin yeni deployment'ının tamamlanmasını bekle.
5. Önce `https://film-proxy-test.vercel.app/__echo` adresini aç. JSON'da `runtime: vercel-node` ve `forwardedPathname: /__echo` beklenir.
6. Ardından `https://film-proxy-test.vercel.app/health` adresini kontrol et. `tursoConnected: true` beklenir.
7. Bunlar başarılı olmadan admin token girişini tekrar tekrar deneme.

## Tanılama yorumlama

- `/__echo` 404: İstek Vercel catch-all fonksiyonuna ulaşmıyor veya doğru deployment/proje çalışmıyor.
- `/__echo` 200, fakat `forwardedPathname` beklenmedik: rewrite/URL strip davranışını düzeltmek gerekir.
- `/__echo` 200 ve `hasAdminToken: false`: Vercel test ortamında `ADMIN_TOKEN` değişkeni eksik veya bu deployment'a uygulanmamış.
- `/health` 200 ama `tursoConnected: false`: Node adapter, TEST Turso değişkenleri veya veritabanı erişimi ayrıca incelenmeli.
- `/health` `tursoConnected: true` ve admin girişi yine başarısız: `/auth/me` yanıtı, Set-Cookie ve tarayıcıdaki `sid_test` gönderimi incelenmeli.

`/__echo` geçici teşhis endpoint'idir; yönlendirme doğrulandıktan sonra kaldırılmalıdır.

## Yerel doğrulama

Yamadaki altı JavaScript dosyasının `node --check` sözdizimi kontrolü başarılıdır. Ortak adapter için mock `first`, `all` ve `batch` testleri başarılıdır. Bu doğrulama gerçek Vercel deployment'ı veya test Turso bağlantısını kanıtlamaz.
