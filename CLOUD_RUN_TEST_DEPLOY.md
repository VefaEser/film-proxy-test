# Film API — Cloud Run TEST geçişi

Bu backend yalnızca TEST ortamı içindir. `server.js` çalışma ortamına `IS_TEST_ENV=true` değerini zorlar; Worker giriş noktası da `createTursoAdapter(env, true)` kullanır. Test Turso bilgileri yoksa servis DB bağlantısı kuramaz; canlı Turso bilgilerine geri dönüş yapılmaz.

## Gerekli Secret Manager secret adları

Aşağıdaki değişkenleri Cloud Run'a Secret Manager üzerinden bağlayın. Değerleri kaynak dosyalarına, Git'e veya bu belgeye yazmayın.

- `TEST_TURSO_DATABASE_URL` (zorunlu)
- `TEST_TURSO_AUTH_TOKEN` (zorunlu)
- Kullanılan sağlayıcılara göre: `TMDB_API_KEY`, `OMDB_API_KEY`, `GEMINI_API_KEY_1`–`3`, `GROQ_API_KEY_1`–`3`, `TAVILY_API_KEY` vb.
- `ADMIN_TOKEN` ve `CRON_SECRET` (yönetim / zamanlanmış görev kullanılıyorsa)

## Yerel imaj testi

```bash
docker build -t film-api-test .
docker run --rm -p 8080:8080 \
  -e IS_TEST_ENV=true \
  -e TEST_TURSO_DATABASE_URL="$TEST_TURSO_DATABASE_URL" \
  -e TEST_TURSO_AUTH_TOKEN="$TEST_TURSO_AUTH_TOKEN" \
  film-api-test
```

## Cloud Run dağıtımı

Önce Google Cloud projesinde Cloud Run, Artifact Registry ve Secret Manager API'lerini etkinleştirin. Ardından TEST servis hesabına yalnızca gerekli secret erişimlerini verin. Servisi `europe-west4` veya seçilen uygun bölgede ayrı bir test servisi adıyla dağıtın.

Örnek (secret adlarının Secret Manager'da önceden oluşturulmuş olması gerekir):

```bash
gcloud run deploy film-api-test \
  --source . \
  --region europe-west4 \
  --allow-unauthenticated \
  --set-env-vars IS_TEST_ENV=true \
  --set-secrets TEST_TURSO_DATABASE_URL=TEST_TURSO_DATABASE_URL:latest,TEST_TURSO_AUTH_TOKEN=TEST_TURSO_AUTH_TOKEN:latest,CRON_SECRET=FILM_TEST_CRON_SECRET:latest
```

API anahtarlarını da yalnızca gereken secret adlarıyla `--set-secrets` üzerinden ekleyin. `--set-env-vars` içine anahtar değerlerini koymayın.

## Zamanlanmış görev

Cloudflare Cron'un Cloud Run karşılığı Cloud Scheduler'dır. Scheduler, dakikalık POST isteğini şu adrese gönderir:

`https://<CLOUD_RUN_TEST_URL>/internal/run-admin-tasks`

Header:

`Authorization: Bearer <CRON_SECRET>`

Scheduler'ın cron sıklığı mevcut test davranışıyla uyumlu olacak şekilde `* * * * *` olabilir. Önce test ortamında tek bir çağrıyla doğrulayın. Aynı görev iki kez eşzamanlı çalıştırılmamalıdır; uygulama kuyruğu/lease kontrolleri ayrıca izlenmelidir.

## Geçiş sırası ve güvenlik

1. Test secret'larının gerçekten test Turso veritabanına ait olduğunu doğrulayın.
2. Cloud Run test servisini dağıtın ve `/health` yanıtında `tursoConnected=true` olduğunu kontrol edin.
3. Araştırma SSE, oturum, admin ve dosya aktarım uç noktalarını test edin.
4. Cloud Scheduler görevini test edin.
5. Ancak tüm kontrollerden sonra frontend `API_BASE` değerini Cloud Run test URL'sine çevirin.
6. Eski test Worker'ı doğrulama bitene kadar silmeyin.

Bu belge dağıtım yapıldığı anlamına gelmez. Bu çalışma sırasında Google Cloud'a, Turso'ya, GitHub'a veya Hugging Face'e bağlantı/dağıtım yapılmamıştır.
