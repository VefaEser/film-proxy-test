# kestiktest5 — eksiklerin giderilmesi ve doğrulama raporu

## Kaynak ve kapsam

- Başlangıç: `kestiktest5.zip` içindeki GitHub-test ve HuggingFace-test dosyaları.
- Daha önce gönderilen iki öneri arşivindeki dört dosya değişikliği korunmuştur.
- Yalnızca test deposu kopyası hazırlanmıştır. Canlı Worker, canlı Turso ve test Turso üzerinde uzaktan işlem yapılmamıştır.
- `llm.js` değiştirilmemiştir.

## Uygulanan geliştirmeler

### 1. Kalıcı, film başına yönetici görev kuyruğu

- `migrations/0048_admin_task_items.sql` ile `admin_task_items` tablosu eklendi.
- Her film/işlem ayrı kuyruk kaydıdır; `admin_tasks` artık yalnızca üst görev ve toplam ilerleme kaydını tutar.
- Atomik `UPDATE ... RETURNING` ile görev öğesi sahiplenme ve 10 dakikalık lease mekanizması eklendi.
- Worker kesilirse süresi dolan `running` öğe yeniden sahiplenilebilir.
- İşlemler en fazla 3 kez denenir; kalıcı hata kaydı tutulur.
- Tamamlanan/başarısız öğe sayıları Turso'dan yeniden hesaplanır.
- İptal, yeniden başlatma ve görev/öğe durumunu görüntüleme uç noktaları eklendi.
- İşlemler at-least-once modelindedir. Silme/yenileme işlemleri idempotent olacak şekilde yazılmıştır; bu, ağ/Worker kesintilerinde aynı öğenin tekrar denenebilmesi içindir.

### 2. Görevlerin kesinti sonrası devamı

- `wrangler.json` içine dakikalık Cron tetikleyicisi eklendi.
- `index.js` scheduled handler yalnızca test Turso bağlantısını kullanır.
- Yönetim panelinde Toplu Görevler sekmesi eklendi. Panel açıkken çalışan görevler `/admin/bulk/step` üzerinden ilerletilir; panel kapanırsa Cron devam eder.
- Görev sahibi için gerekli izin her öğe işlenmeden önce yeniden kontrol edilir.

### 3. 250 / 2.000 / tüm kayıt hedefleri

- Veritabanı kartlarını yenileme ve eksik kartları oluşturma görevlerinde `targetCount: 250`, `2000` veya `all` desteklenir.
- Veritabanı kart listesinde seçili kartları yenileme ve silme kontrolleri eklendi.
- Kart silme, `movie_profiles` ve `movie_profile_fields` kayıtlarını kaldırır; üye listesi satırlarını ve puanlarını silmez, ilgili `tmdb_id` bağlantısını boşaltır.

### 4. CSV kartlarında toplu işlemler

- Seçilen CSV satırlarından eksik kart oluşturma.
- Seçilen mevcut TMDB kartlarını yenileme.
- Seçilen CSV kaynaklı kullanıcı-listesi kayıtlarını kaldırma.
- Seçilen CSV kayıtlarının bağlı TMDB kartlarını silme.
- Her işlem ayrı yetkiyle kontrol edilir ve kalıcı görev kuyruğunda yürütülür.
- Liste kaydı kaldırılırken puanlı kayıt `rating_only` listesine korunur.

### 5. Kullanıcı listeleri

- Yönetici kullanıcı listesi seçicisinde sayfalama ve 10–100 sayfa boyutu eklendi.
- Kullanıcı listesi modalında sayfalama ve sayfa boyutu eklendi.
- İzlediklerim / İzleyeceklerim / İzlemeyeceklerim listelerinde seçili kayıtları kaldırma ve tüm listeyi temizleme kontrolleri eklendi.
- Her iki işlem de önce önizleme, sonra onay akışı kullanır; kayıt sayısı ve snapshot hash değişmişse görev oluşturulmaz.
- Puanlar `rating_only` listesinde korunur.

### 6. Harici veri kümeleri

- Harici veri kümelerini listeleme ve kayıtlarını sayfalama uç noktaları eklendi.
- Seçili kayıtları veri kümesinden kaldırma ve tüm veri kümesini silme görevleri eklendi.
- Tüm veri kümesini silme işlemi, ilgili `global_movies` kayıtları tamamlandıktan sonra `import_jobs` geçmişini de temizleyen sonlandırma öğesi kullanır.
- Harici veri görüntüleme, kaldırma ve silme ayrı izinlerle kontrol edilir.
- Veri kümesi silme isteğinde onay anındaki satır sayısı yeniden doğrulanır.

### 7. IMDb → TMDB eşleştirme doğrulaması

- Tek TMDB adayı bulunması artık tek başına otomatik eşleştirme nedeni değildir.
- Sağlanan başlık ve yıl adayla uyuşmuyorsa eşleştirme reddedilir.
- CSV'de yönetmen bilgisi varsa TMDB credits üzerinden yönetmen doğrulaması yapılır.
- Belirsiz/uyuşmayan aday 422 `ambiguous` olarak döner; CSV kaydı otomatik silinmez veya başka filme bağlanmaz.
- Kuyrukta belirsiz eşleştirme terminal hata olarak kaydedilir; gereksiz tekrar API çağrısı yapılmaz.

### 8. Önceki dört öneri dosyası

- `fields.config.js`: `concept` hikâye boyutu kaldırıldı.
- `index.js`: Turso teşhis alanları.
- `appadmin.js`: eski `concept` açıklaması temizlendi.
- `user-ui3.js`: Veritabanı adı ve yönetim ekranı güncellemeleri.

## Doğrulama sonuçları

- JavaScript sözdizimi: 39 dosya, tümü başarılı (`node --check`).
- JSON yapılandırmaları: 3 dosya, tümü geçerli.
- `0048_admin_task_items.sql`: SQLite testinde tablo, foreign key, atomik sahiplenme ve `RETURNING` kontrolü başarılı.
- Görev özeti ve yeniden deneme SQL akışı: SQLite testinde başarılı.
- Gizli ortam dosyası / `.cache` / `.git` içeriği ZIP'e alınmadı.
- `llm.js` SHA-256 karşılaştırması: başlangıç arşiviyle aynı.

## Dağıtım öncesi zorunlu adımlar ve sınırlar

1. `0048_admin_task_items.sql` henüz test Turso'ya uygulanmadı. Test migration iş akışında önce DRY-RUN kontrolü yapılmalı; yalnızca test DB hedefi ve doğru kimlik bilgileri teyit edildikten sonra `APPLY_MIGRATIONS=true` ile uygulanmalıdır.
2. Cloudflare test Worker'a dağıtım yapılmadı. `wrangler.json` Cron ayarı dağıtım sonrasında etkinleşir.
3. Android gerçek cihaz etkileşim testi bu ortamdan yapılamadı.
4. Yönetici token girişinin gerçek Cloudflare secret/cookie ortamında uçtan uca güvenlik testi yapılmadı.
5. Worker/Cron ve Turso migration uygulanmadan yeni görev uç noktaları canlı test edilmiş sayılamaz.

## Önemli çalışma garantisi

Bu paket test deposu için hazırlanmış kaynak kodudur. Migration'ın uygulanması ve test Worker dağıtımı yapılmadan kalıcı görev kuyruğu çalışır durumda kabul edilmemelidir. Canlı ortama ait hiçbir ayar veya veritabanı değiştirilmemiştir.
