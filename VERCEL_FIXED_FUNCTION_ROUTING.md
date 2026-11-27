# Vercel sabit Node.js Function yönlendirmesi (test projesi)

Bu düzenleme yalnızca `VefaEser/film-proxy-test` deposu içindir. Canlı `film-proxy`, canlı Worker ve canlı veritabanı bu paketin hedefi değildir.

## Dosya değişiklikleri

- `api/worker.js`: Tek sabit Node.js Function. Gelen HTTP isteğini mevcut `index.js` Worker uygulamasına aktarır.
- `vercel.json`: Genel yolları `/api/worker` fonksiyonuna yönlendirir ve özgün yolu `__vercel_route_path` query parametresiyle açıkça taşır.
- `api/[...path].js`: Kullanılmıyor; silinmiş olmalıdır. `api/worker.js` kalır.

## Kurulum

1. Bu paketteki proje dosyalarını `VefaEser/film-proxy-test` deposunun `main` dalına yerleştir.
2. `api/worker.js` dosyasının `api` klasöründe bulunduğunu, `api/[...path].js` dosyasının bulunmadığını doğrula.
3. Vercel projesinin Root Directory ayarı depo kökünü göstermeli.
4. Vercel'de yeni deployment oluştur. Eski deployment'ı yeniden dağıtmak yerine `main` dalının son commit'inden deployment alındığını doğrula.
5. Proje Hobby planında olduğundan `maxDuration` 60 saniyedir.

## Sıralı test

Önce veritabanından bağımsız yönlendirme testi:

`https://film-proxy-test.vercel.app/__vercel-route-check`

Başarılı yanıtın `ok: true`, `function: "api/worker.js"`, `routePath: "/__vercel-route-check"` ve `testEnvironment: true` alanlarını içermesi gerekir.

Eğer `Vercel yönlendirme yolu parametresi alınamadı` yanıtı gelirse fonksiyon çalışıyor fakat rewrite parametresi aktarılmıyordur. Eğer `Uç nokta bulunamadı` yanıtı gelirse bu kontrolün yeni fonksiyona ulaşmadığı veya eski sürümün çalıştığı araştırılmalıdır.

Ardından:

`https://film-proxy-test.vercel.app/health`

Bu ikinci test uygulama ve test Turso bağlantısını kontrol eder. İlk yönlendirme testi başarılı olmadan DB/admin girişini test etme.

## Teknik notlar

- `vercel.json` içindeki rewrite hedefi, wildcard yakalamasını hedef fonksiyona açık query parametresi olarak aktarır. Böylece handler'ın varsayılan `/` yoluna sessizce düşmesi önlenir.
- `api/worker.js`, mevcut uygulama rotalarını `index.js` içindeki `worker.fetch()` fonksiyonuna aktarır.
- `IS_TEST_ENV` daima `true` yapılır; test Turso değişkenleri eksikse canlı DB'ye fallback yapılmaz.
- `api/worker.js` fonksiyonu doğrudan `api/worker` yolundan çağrıldığında `__vercel_route_path` yoksa 400 teşhis yanıtı verir. Normal kullanımda kök rotalar `vercel.json` üzerinden yönlendirilir.
