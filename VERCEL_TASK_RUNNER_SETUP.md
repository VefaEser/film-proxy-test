# Vercel test ortamı — kalıcı toplu görev kuyruğu

Bu yama yalnızca test deposundaki `admin.js` ve `index.js` dosyalarını değiştirir.

## Vercel ortam değişkeni

Vercel test projesinde Settings → Environment Variables bölümüne şu değişkeni ekleyin:

- Name: `TASK_RUNNER_SECRET`
- Value: kullanıcı tarafından oluşturulmuş, en az 32 karakterlik rastgele gizli değer
- Environments: Preview ve Production (yalnızca film-proxy-test projesinde)

Bu değer frontend'e, GitHub dosyalarına veya sohbete yazılmamalıdır. Yeniden deploy gerekir.

## Nasıl çalışır?

- `/admin/bulk/run` ve `/admin/bulk/task/resume` başarılı olduğunda sunucu gizli dahili endpoint'i tetikler.
- `/internal/run-admin-tasks` yalnızca `Authorization: Bearer <TASK_RUNNER_SECRET>` ile çağrılabilir.
- Her Vercel çağrısı Turso kuyruğundan yalnızca bir öğe alır. Öğe tamamlanınca sıradaki çağrı tetiklenir.
- İş öğeleri ve lease bilgileri Turso'da kalır. Çakışan çağrılarda atomik claim/lease mekanizması korunur.
- İşlenecek öğe kalmadığında zincir durur. Hatalı öğeler mevcut deneme politikasına göre yeniden kuyruğa alınır veya başarısız işaretlenir.

## Ön koşullar

Test Turso veritabanında `0043_admin_tasks.sql` ve `0048_admin_task_items.sql` migration'ları uygulanmış olmalıdır. Migration'ları bu yama otomatik çalıştırmaz. Önce mevcut test DB migration durumunu doğrulayın.

## Sınırlar

Bu mekanizma `admin_tasks` kuyruğundaki toplu kart ve CSV-kaynaklı kart görevlerini (ör. `create_csv_cards`, `refresh_csv_cards`, `delete_csv_cards`) arka planda sürdürür.

`/hf-import/file/*` ve kullanıcı CSV oturumlarının ham dosya satırlarını tarayıcıdan parça parça gönderen akışı farklıdır. Tarayıcı kapanınca henüz sunucuya gönderilmemiş CSV satırları kendiliğinden işlenemez. Bu akışın tamamen tarayıcıdan bağımsız olması için CSV satırlarının sunucu tarafında kalıcı saklanması ayrıca tasarlanmalıdır.

## Güvenlik ve test

- `TASK_RUNNER_SECRET` tanımlı değilse otomatik tetikleme fail-closed davranır.
- Bu yama canlı repo, canlı Worker veya canlı Turso'ya dokunmaz.
- Dağıtımdan önce yalnızca test projesinde doğrulayın.
