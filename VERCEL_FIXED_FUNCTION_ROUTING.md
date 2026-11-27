# Vercel sabit Node.js Function yönlendirmesi (TEST)

Bu test projesinde bütün uygulama yolları tek bir sabit Node.js Function olan `api/worker.js` dosyasına yönlendirilir.

- `api/[...path].js` kaldırıldı.
- `vercel.json`, `/:__vercel_route_path*` desenini `/api/worker` hedefine yönlendirir.
- Vercel'in kullanılmayan wildcard parametresini query parametresi olarak aktarma davranışı kullanılır; fonksiyon bu değeri alıp Worker uygulamasına özgün pathname olarak iletir.
- Orijinal sorgu parametreleri korunur; yönlendirme parametresi uygulama isteğinden çıkarılır.
- `GET /__vercel-route-check`, DB/API başlatmadan sabit fonksiyonun ve path aktarımının doğrulanması için test endpoint'idir.
- `IS_TEST_ENV=true` ve yalnızca `TEST_TURSO_*` değişkenleri kullanımı korunmuştur.

Dağıtım testi:

1. Bu arşivin içeriğini `VefaEser/film-proxy-test` deposunun `main` dalına yükleyin.
2. Vercel test projesinde mevcut manuel redeploy yönteminizle yeni deployment başlatın.
3. `https://film-proxy-test.vercel.app/__vercel-route-check` adresini açın. `ok: true` ve `function: "api/worker.js"` dönmelidir.
4. Ardından `/health` ve `/admin/ping` yollarını kontrol edin.

Bu değişiklikler yalnızca test deposu/projesi içindir; canlı `film-proxy`, canlı Worker veya canlı veritabanına uygulanmamıştır.
