# KESTİK
## Film Keşif, Araştırma ve Görsel Analiz Sistemi

Kestik; farklı film veri kaynaklarını bir araya getiren, kullanıcıların gelişmiş filtrelerle film keşfetmesini sağlayan, film bilgilerini zenginleştiren, yapay zekâ destekli araştırma ve görsel analiz özellikleri sunan modüler bir film keşif sistemidir.

Sistem; kullanıcı arayüzü, backend, harici veri kaynakları, yapay zekâ servisleri, görsel işleme altyapısı ve veritabanı olmak üzere birbirinden ayrılmış bileşenlerden oluşur.

Bu mimarinin temel amacı, kullanıcı arayüzünü sunucu işlemlerinden ayırmak, gizli anahtarları güvenli biçimde korumak, veri kaynaklarını birbirinden bağımsız kullanabilmek ve yapılan değişiklikleri canlı sisteme aktarmadan önce test edebilmektir.

-----

# 1. Genel sistem mimarisi

Kestik tek bir sunucudan oluşmaz. Farklı görevleri yerine getiren servisler birlikte çalışır.

| Bileşen | Görevi |
|---|---|
| Hugging Face Spaces | Kullanıcı arayüzünü barındırır |
| GitHub | Backend kaynak kodunun ve sürüm geçmişinin tutulduğu ana depodur |
| Vercel | Node.js backend fonksiyonlarını çalıştırır |
| Cloudflare Workers | Proxy, sunucu tarafı yönlendirme ve gizli yapılandırma entegrasyonlarını yürütür |
| Turso | Kalıcı veritabanı hizmetini sağlar |
| TMDB | Film kataloğu ve temel film verilerini sağlar |
| OMDb | IMDb ve diğer film bilgileri için ek veri kaynağıdır |
| Tavily | Web araştırması ve bilgi bulma işlemlerini destekler |
| Gemini | Birincil yapay zekâ analiz servisidir |
| Groq | Yapay zekâ işlemleri için yedek model sağlayıcısıdır |
| Crawlora | Görsel toplama altyapısını destekler |

Bileşenlerin her biri kendi sorumluluğuna sahiptir. Bir serviste meydana gelen sorun, mümkün olduğunca diğer bileşenlerin çalışmasını engellemeyecek şekilde ele alınır.

## 1.1. Sistem akışının özeti

```text
KULLANICI
   |
   v
HUGGING FACE
Statik web arayüzü
   |
   v
API İSTEKLERİ
   |
   v
BACKEND / VERCEL
Node.js Functions
   |
   +----------------------+
   |                      |
   v                      v
CLOUDFLARE WORKER       BACKEND MODÜLLERİ
Proxy / Entegrasyon     API / İş mantığı
   |                      |
   +----------+-----------+
              |
     +--------+--------+
     |        |        |
     v        v        v
   TMDB     OMDb    Tavily
     |
     v
Film verilerinin
birleştirilmesi
     |
     +----------------------+
     |                      |
     v                      v
GEMINI / GROQ          TURSO
AI analizleri          Kalıcı kayıt
     |
     v
Görsel ve metin
analiz sonuçları
     |
     v
Kullanıcı arayüzüne
sonuçların aktarılması
```

Bu şema sistemin işlevsel bileşenlerini gösterir. Gerçek isteklerin hangi servis üzerinden geçtiği, ilgili API uç noktasının yapılandırmasına bağlıdır.

-----

# 2. Hugging Face – Kullanıcı arayüzü

Hugging Face Spaces, Kestik'in kullanıcı tarafından görülen web arayüzünü barındırır.

Arayüzün statik olarak sunulması sayesinde kullanıcı arayüzü, backend sunucusundan bağımsız biçimde çalışabilir.

Hugging Face tarafının temel görevleri:

- Web sayfasını kullanıcıya sunmak.
- Film arama ve filtreleme kontrollerini göstermek.
- Kullanıcı seçimlerini toplamak.
- Backend API isteklerini göndermek.
- Gelen film sonuçlarını görüntülemek.
- Film posterlerini ve detaylarını sunmak.
- Kullanıcı listelerini ve diğer arayüz özelliklerini yönetmek.
- Görsel galeriyi ve analiz sonuçlarını göstermek.

### 2.1. Statik frontend mimarisi

Hugging Face üzerinde Docker veya sürekli çalışan bir Node.js sunucusuna ihtiyaç duymayan statik frontend yaklaşımı kullanılır.

HTML, CSS ve JavaScript dosyaları tarayıcıda çalışır.

Önemli ayrım:

**Hugging Face frontend, gizli API anahtarlarının tutulacağı yer değildir.**

TMDB, Gemini, Groq, OMDb ve diğer servislerin gizli anahtarları tarayıcıya gönderilmemelidir. Bu anahtarlarla ilgili işlemler sunucu tarafında gerçekleştirilmelidir.

### 2.2. Frontend'in backend ile iletişimi

Kullanıcı bir film araması yaptığında:

1. Arayüz kullanıcının filtrelerini toplar.
2. İlgili API isteğini oluşturur.
3. Yapılandırılmış backend adresine isteği gönderir.
4. Backend işlemi gerçekleştirir.
5. Sonuçları JSON biçiminde döndürür.
6. Arayüz gelen sonuçları film kartlarına dönüştürür.

Böylece kullanıcı arayüzü ile backend birbirinden bağımsız geliştirilebilir.

### 2.3. Kullanıcı deneyimi

Arayüzde amaçlanan temel özellikler:

- Film yılı filtresi.
- TMDB film puanı filtresi.
- Ülke, dil ve tür seçimleri.
- Birden fazla filtreyi aynı anda kullanabilme.
- Dahil etme ve hariç tutma mantığı.
- Film kartları ve posterler.
- Film detaylarının genişletilmesi.
- Kullanıcı film listeleri.
- İzlenen, izlenmek istenen ve izlenmeyecek filmler.
- Kullanıcı puanlamaları.
- Görsel galeri ve analiz sonuçları.

Arayüzün görevi veri üretmek değil, kullanıcı ile backend arasındaki etkileşimi sağlamaktır.

---

# 3. GitHub – Kaynak kodu ve sürüm yönetimi

GitHub, sistemin backend kaynak kodunun ve proje yapılandırmasının tutulduğu merkezdir.

Burada uygulamanın sunucu tarafındaki mantığı, API modülleri, veritabanı işlemleri, migration dosyaları ve yardımcı betikleri bulunur.

GitHub'ın temel görevleri:

- Kaynak kodunu saklamak.
- Değişiklikleri ve sürüm geçmişini takip etmek.
- Modüllerin geliştirilmesini sağlamak.
- Test ve canlı kodlarını ayrı tutmak.
- Dağıtım sistemlerine kaynak sağlamak.
- Kod incelemesi ve hata düzeltme süreçlerini desteklemek.

GitHub kendi başına film araması veya AI analizi gerçekleştirmez. Bu işlemleri çalıştıran kodu barındırır.

### 3.1. Test ve canlı depo ayrımı

Kestik geliştirme sürecinde test ve canlı ortamlar birbirinden ayrıdır.

**Canlı depo:**

`https://github.com/VefaEser/film-proxy`

**Test deposu:**

`https://github.com/VefaEser/film-proxy-test`

Test deposunda yapılan değişiklikler doğrudan canlı sistemin kaynak kodunu değiştirmez.

Yeni özellikler önce test ortamında doğrulanmalı, ardından canlı sisteme aktarılmalıdır.

---

# 4. Vercel – Backend çalışma ortamı

Vercel, Node.js tabanlı backend fonksiyonlarının çalıştırıldığı sunucu ortamıdır.

Hugging Face statik arayüzünün tek başına gerçekleştiremeyeceği işlemler burada yürütülür.

Backend'in sorumlulukları:

- API isteklerini karşılamak.
- İstekleri ilgili modüllere yönlendirmek.
- Harici servislerle iletişim kurmak.
- Kullanıcı kimlik doğrulamasını yürütmek.
- Film verilerini işlemek.
- Veritabanı işlemlerini gerçekleştirmek.
- Yapay zekâ servislerini çağırmak.
- Sonuçları frontend'e göndermek.

### 4.1. Node.js Functions mimarisi

Backend, Vercel'in standart Node.js Functions çalışma modeline uygun biçimde yapılandırılır.

Temel bileşenler:

- `api/worker.js`: Vercel fonksiyon giriş noktası.
- `index.js`: Backend ana yönlendirme ve çalışma mantığı.
- `worker-core.js`: Ortak çalışma mantığı.

Bu yaklaşımın amacı, bütün API trafiğini tek bir belirsiz sunucu mimarisine bağlamak yerine Vercel'in desteklediği fonksiyon yapısından yararlanmaktır.

### 4.2. Modüler backend

Backend işlemleri farklı JavaScript modüllerine ayrılmıştır.

Bu sayede kullanıcı yönetimi, film araştırması, veritabanı ve görsel analiz gibi işlevler birbirinden bağımsız geliştirilebilir.

---

# 5. Cloudflare Workers – Proxy ve sunucu tarafı entegrasyon

Cloudflare Workers, Kestik mimarisinde proxy ve sunucu tarafı entegrasyon görevlerini destekler.

Özellikle harici servislerle iletişim ve gizli yapılandırmaların korunması açısından önemlidir.

Cloudflare tarafındaki temel ilkeler:

- Gizli anahtarlar istemci tarafına gönderilmez.
- API erişimleri sunucu tarafında gerçekleştirilir.
- Test ve canlı Worker yapılandırmaları birbirinden ayrılır.
- Backend ile Worker arasındaki iletişim açıkça tanımlanır.
- Test işlemleri canlı Worker üzerinde yürütülmez.

### 5.1. Test Worker

Test ortamındaki Worker:

`https://film-api-proxy-test` değil, yapılandırılmış test adresi olan:

`https://film-api-proxy.stavaft.workers.dev`

Bu servis test ortamına aittir.

Canlı Worker:

`https://film-proxy.stavaft.workers.dev`

Test ve canlı Worker'ın ayrı tutulması, test sırasında canlı sistemin etkilenmesini önlemeye yardımcı olur.

---

# 6. Turso – Kalıcı veritabanı

Turso, sistemin kalıcı verilerinin saklandığı veritabanı hizmetidir.

Backend, veritabanına sunucu tarafındaki adaptör üzerinden erişir.

Veritabanı; kullanıcıların, film listelerinin, puanlamaların ve sistem tarafından saklanması gereken diğer kayıtların tutulması için kullanılır.

### 6.1. Veritabanı adaptörü

`db.js` ve `turso-adapter.js` gibi modüller, backend ile veritabanı arasındaki erişim katmanını oluşturur.

Adaptör yaklaşımı sayesinde veritabanı bağlantı ayrıntıları uygulamanın diğer modüllerinden ayrılır.

### 6.2. Migration sistemi

`migrations/` klasöründe veritabanı şema değişiklikleri sıralı SQL dosyalarıyla tutulur.

Migration sistemi:

- Tabloları oluşturur.
- Gerekli sütunları ekler.
- İndeksleri oluşturur.
- Veri yapısını günceller.
- Eski şemadan yeni şemaya kontrollü geçiş sağlar.

Migration dosyalarının sırası ve geçmişi korunmalıdır.

### 6.3. Test ve canlı veritabanı ayrımı

Test ortamı kendi Turso veritabanını kullanır.

Test bağlantısı için:

- `TEST_TURSO_DATABASE_URL`
- `TEST_TURSO_AUTH_TOKEN`

Bu değişkenler yalnızca test backend ortamında tanımlanmalıdır.

Canlı veritabanı bilgileri test koduna veya herkese açık dosyalara eklenmemelidir.

---

# 7. Film veri kaynakları

Kestik'in film keşif sistemi farklı veri kaynaklarını kullanarak film bilgilerini toplar ve birleştirir.

## 7.1. TMDB

TMDB, film keşif sisteminin temel film katalog kaynaklarından biridir.

Kullanıldığı temel bilgiler:

- Film adı.
- Orijinal film adı.
- Türkçe film adı.
- Film özeti.
- Yayın yılı.
- Poster.
- Türler.
- Ülke bilgileri.
- Orijinal dil.
- Konuşulan diller.
- Kullanıcı puanı.
- Oy sayısı.
- Film kimliği.

TMDB verileri, film arama ve filtreleme işlemlerinin temelini oluşturur.

### Film tarama mantığı

Sistemin amaçlanan tarama davranışı:

1. TMDB'den aday filmler alınır.
2. Adaylar puan sırasına göre değerlendirilir.
3. Filtrelere uyan filmler seçilir.
4. İlk 10 eşleşme kullanıcıya gösterilir.
5. Kullanıcı sonraki sonuçları istediğinde bir sonraki 10 film getirilir.

Bu yaklaşım, yalnızca ilk sayfadaki filmleri göstermek yerine daha geniş bir aday kümesini taramayı hedefler.

## 7.2. OMDb

OMDb, film bilgilerinin zenginleştirilmesi için kullanılan ek veri kaynağıdır.

Uygun kayıtlar bulunduğunda:

- IMDb puanı.
- IMDb kimliği.
- Ek film bilgileri.
- Kaynakta bulunan diğer metadata alanları

alınabilir.

TMDB ve OMDb kayıtları gerektiğinde eşleştirilerek film bilgilerinin kapsamı artırılır.

## 7.3. Tavily

Tavily, web araştırması ve harici bilgi bulma işlemlerini destekler.

Özellikle standart film kataloglarında bulunmayan bilgilerin araştırılmasında kullanılabilir.

Örneğin:

- Filmin çekim yeri.
- Hikâyenin dayandığı eser.
- Uyarlama bilgisi.
- Yazar veya kaynak eser.
- Ek bağlamsal bilgiler.

Araştırma sonuçları doğrulanmadan kesin bilgi olarak kabul edilmemelidir.

---

# 8. Film filtreleme sistemi

Kestik'in önemli özelliklerinden biri, birden fazla filtreyi aynı anda kullanabilmesidir.

Filtreleme işlemleri mümkün olduğunca mevcut veri ve deterministik kurallarla yapılır. Her filtre için yapay zekâ çağrısı yapmak zorunlu değildir.

### 8.1. Temel filtreler

- Film yılı.
- TMDB puanı.
- Oy sayısı.
- Tür.
- Ülke.
- Orijinal dil.
- Konuşulan diller.

### 8.2. Üç durumlu filtre mantığı

Bazı filtreler üç farklı durumda çalışabilir:

1. Nötr: Filtre uygulanmaz.
2. Dahil et: Seçilen değer eşleşmelidir.
3. Hariç tut: Seçilen değer eşleşmemelidir.

Bu yöntem, karmaşık film aramalarında daha fazla kontrol sağlar.

### 8.3. Çakışan filtreler

Bir film aynı anda dahil etme ve hariç tutma kurallarına takılabilir.

Bu durumun nasıl ele alınacağı sistemin çakışma politikasına bağlıdır.

Amaç, kullanıcının açıkça belirlediği filtrelerin beklenmedik biçimde birbirini geçersiz kılmasını önlemektir.

### 8.4. Yapay zekâsız çalışma

Sistemde AI kullanımını devre dışı bırakan bir çalışma yaklaşımı bulunur.

AI kapalıyken:

- Temel katalog verileri kullanılabilir.
- Mevcut metadata üzerinden filtreleme yapılabilir.
- Türkçe ve İngilizce anahtar kelime eşleştirmeleri kullanılabilir.
- Gemini ve Groq çağrıları gerektiren analizler yapılmaz.

Böylece temel film keşfi, yapay zekâ servislerine bağımlı olmadan çalışabilir.

---

# 9. Yapay zekâ altyapısı

Kestik, yapay zekâyı bütün işlemlerin merkezine yerleştirmek yerine ihtiyaç duyulan alanlarda kullanmayı hedefler.

Bu yaklaşım hem maliyet kontrolü hem de servis güvenilirliği açısından önemlidir.

## 9.1. Gemini – Birincil model

Gemini, sistemdeki birincil yapay zekâ sağlayıcısıdır.

Kullanım alanları:

- Film hikâyesi analizi.
- Anlamsal filtreleme.
- Film bilgilerini sınıflandırma.
- Görsel içerik analizi.
- Kaynaklardan elde edilen bilgilerin yorumlanması.
- Eksik metadata alanlarının araştırılmasına yardımcı olma.

AI işlemleri yalnızca gerekli alanlarda çalıştırılmalıdır.

## 9.2. Groq – Yedek model sağlayıcısı

Gemini servisinde hata, kapasite sorunu veya erişim problemi oluştuğunda uygun işlemlerde Groq kullanılabilir.

Amaç, tek bir model sağlayıcısına bağımlılığı azaltmaktır.

Yedek modele geçiş, ilgili işlemin desteklediği model ve çıktı formatıyla uyumlu olmalıdır.

## 9.3. Model seçimi ve maliyet kontrolü

Sistemde model seçimi, yedek model sıralaması ve kullanım sınırları yapılandırılabilir.

Önemli kontrol noktaları:

- Model sürümü.
- İstek başına film sayısı.
- Maksimum çıktı uzunluğu.
- İstek zaman aşımı.
- Token sınırları.
- Servis hata yönetimi.
- Tekrarlanan analizlerin önlenmesi.

## 9.4. AI sonuçlarının önbelleğe alınması

Aynı film için aynı analizin tekrar tekrar yapılması gereksiz maliyet oluşturur.

Bu nedenle AI analiz sonuçlarının veritabanında önbelleğe alınması hedeflenir.

Önbellek kayıtlarında şu bilgiler önemlidir:

- Film kimliği.
- Analiz türü.
- Model adı ve sürümü.
- Analiz sonucu.
- Veri kaynağı.
- Oluşturulma zamanı.
- Geçerlilik süresi.

Model veya analiz mantığı değiştiğinde eski sonuçların yeniden kullanılmaması için sürüm bilgisi önemlidir.

---

# 10. Görsel toplama ve analiz sistemi

Kestik'in görsel altyapısı, film posterlerinden daha kapsamlı bir görsel araştırma ve analiz iş akışını destekler.

Bu bölüm iki ana aşamaya ayrılır:

1. Görsellerin bulunması ve toplanması.
2. Görsellerin yapay zekâ ile analiz edilmesi.

## 10.1. Crawlora – Görsel toplama

Crawlora, görsel kaynaklarının araştırılması ve galeriye alınması sürecini destekler.

Görseller ilgili filmle ilişkilendirilir ve backend tarafından işlenir.

Toplama sırasında dikkat edilmesi gerekenler:

- Görselin hangi filme ait olduğu.
- Kaynak adresi.
- Yinelenen görseller.
- Görsel formatı.
- Dosya boyutu.
- Görselin kullanılabilirliği.
- Kaynak ve analiz kayıtlarının birbirinden ayrılması.

### Görsel boyutu

Görsellerin gereksiz yere yüksek boyutlarda saklanması ve taşınması önlenmelidir.

Proje için belirlenen hedef, galeri görsellerinin sıkıştırılarak yaklaşık 20 KB üst sınırına uygun hale getirilmesidir.

Bu sınır, yalnızca dosya boyutu kontrol edilerek değil, gerçek sıkıştırılmış çıktı üzerinden doğrulanmalıdır.

## 10.2. Görsel analiz

`visual-analysis.js`, görsel analiz işlemlerinin backend tarafındaki modülüdür.

Görsel analizde Gemini gibi çok modlu modeller kullanılabilir.

Analiz süreci genel olarak:

1. Görselin ilgili filmle ilişkisi belirlenir.
2. Görsel analiz için uygun biçime getirilir.
3. Yapay zekâ servisine gönderilir.
4. Modelin ürettiği analiz sonucu alınır.
5. Sonuç doğrulanır ve yapılandırılır.
6. İlgili film ve görselle ilişkilendirilir.
7. Gerekliyse Turso veritabanına kaydedilir.
8. Kullanıcı arayüzünde görüntülenir.

Görselin galeriye eklenmiş olması, AI analizinin tamamlandığı veya analiz sonucunun veritabanına kaydedildiği anlamına gelmez. Bu işlemler ayrı ayrı doğrulanmalıdır.

---

# 11. Kullanıcı sistemi

Kullanıcı işlemleri backend modülleri üzerinden yönetilir.

Önemli modüller:

- `auth.js`: Kimlik doğrulama.
- `users.js`: Kullanıcı verileri ve film listeleri.
- `social.js`: Sosyal özellikler.

### 11.1. Film listeleri

Kullanıcıların filmleri farklı listelere ekleyebilmesi amaçlanır:

- İzlenen filmler.
- İzlenmek istenen filmler.
- İzlenmeyecek filmler.

### 11.2. Kullanıcı puanlamaları

Kullanıcıların verdiği film puanları, normal film listelerinden ayrı bir mantıkla ele alınabilir.

Bir filmin kullanıcı tarafından puanlanmış olması, mutlaka izlenen veya izlenmek istenen listesine eklenmesi gerektiği anlamına gelmez.

Bu ayrım, liste verileri ile puanlama verilerinin birbirine karışmasını önler.

---

# 12. Backend modülleri ve sorumlulukları

Backend'in modüler yapısı, sistemin farklı işlevlerini birbirinden ayırır.

| Modül | Sorumluluk |
|---|---|
| `index.js` | Ana backend giriş ve yönlendirme |
| `worker-core.js` | Ortak çalışma mantığı |
| `api/worker.js` | Vercel fonksiyon giriş noktası |
| `admin.js` | Yönetici API işlemleri |
| `admin-task-queue.js` | Yönetici görev kuyruğu |
| `users.js` | Kullanıcı ve film listesi işlemleri |
| `auth.js` | Kimlik doğrulama |
| `social.js` | Sosyal özellikler |
| `db.js` | Veritabanı erişim katmanı |
| `turso-adapter.js` | Turso adaptörü |
| `config.js` | Yapılandırma |
| `cors.js` | CORS işlemleri |
| `research.js` | Film ve web araştırmaları |
| `filters.js` | Film filtreleme |
| `llm.js` | Yapay zekâ model iletişimi |
| `sources.js` | Harici veri kaynakları |
| `enrich.js` | Film metadata zenginleştirme |
| `crawlora-images.js` | Görsel toplama |
| `visual-analysis.js` | Görsel analiz |
| `pagination.js` | Sayfalama |
| `fields.config.js` | Alan yapılandırmaları |
| `taxonomy.*.js` | Tür, dil, ülke ve benzeri sınıflandırmalar |

Bu ayrım, tek bir dosyanın bütün sistemin sorumluluğunu üstlenmesini engeller.

---

# 13. Bir film aramasının baştan sona çalışma şekli

Örnek olarak kullanıcı şu filtrelerle arama yaptığında:

- 2000–2025 arası.
- Belirli TMDB puanının üzerinde.
- Seçilen türler dahil.
- Belirli ülkeler hariç.
- Belirli bir dilde.

Sistem şu sırayla çalışır:

**1. Kullanıcı arayüzü**

Hugging Face üzerindeki arayüz kullanıcının filtrelerini toplar.

**2. API isteği**

Filtreler backend'e gönderilir.

**3. Backend**

İstek doğrulanır ve ilgili film araştırma modülüne aktarılır.

**4. TMDB**

Uygun film adayları alınır.

**5. Filtreleme**

Temel metadata kullanılarak aday filmler değerlendirilir.

**6. Ek veri kaynakları**

Gerekli durumlarda OMDb ve Tavily gibi kaynaklardan ek bilgiler alınır.

**7. Yapay zekâ**

Yalnızca AI gerektiren alanlar için Gemini veya uygun yedek model kullanılır.

**8. Sonuçların hazırlanması**

Filmler sıralanır, filtrelenir ve sayfalama mantığına göre hazırlanır.

**9. Frontend**

Sonuçlar Hugging Face arayüzüne gönderilir ve kullanıcıya gösterilir.

**10. Önbellek ve kayıt**

Saklanması gereken veriler Turso üzerinde tutulur. Tekrarlanan işlemler için uygun önbellek mekanizmaları kullanılabilir.

---

# 14. Güvenlik ve gizli anahtar yönetimi

Kestik'in temel güvenlik ilkesi, gizli anahtarların istemci tarafında bulunmamasıdır.

Gizli bilgiler:

- TMDB API anahtarı.
- OMDb API anahtarı.
- Gemini API anahtarları.
- Groq API anahtarları.
- Tavily API anahtarı.
- Turso veritabanı URL ve token bilgileri.
- Yönetici erişim bilgileri.

Bu bilgiler ilgili sunucu ortamının secret veya environment variable alanlarında tutulmalıdır.

### Güvenlik kuralları

1. API anahtarları GitHub'a yazılmaz.
2. API anahtarları frontend JavaScript dosyalarına eklenmez.
3. Test ve canlı ortamların secret değerleri ayrılır.
4. Veritabanı erişimi sunucu tarafında gerçekleştirilir.
5. Hata kayıtlarında token ve anahtarlar gösterilmez.
6. Test işlemleri canlı veritabanına yönlendirilmez.
7. Her servis yalnızca ihtiyaç duyduğu erişim bilgilerini kullanır.

---

# 15. Test ve geliştirme süreci

Kestik'in geliştirilmesinde test ortamı ile canlı ortamın ayrılması esastır.

Test ortamındaki temel bileşenler:

| Bileşen | Test adresi |
|---|---|
| GitHub | https://github.com/VefaEser/film-proxy-test |
| Hugging Face | https://vefaeser-kestiktest.static.hf.space/index.html |
| Vercel | https://film-proxy-test.vercel.app |
| Cloudflare Worker | https://film-api-proxy.stavaft.workers.dev |

Test süreci:

1. Değişiklikler test deposunda hazırlanır.
2. Kod ve bağımlılıklar kontrol edilir.
3. Test backend ortamında çalıştırılır.
4. API istekleri doğrulanır.
5. Test veritabanı işlemleri kontrol edilir.
6. Harici servis bağlantıları sınanır.
7. Görsel toplama ve analiz ayrı ayrı test edilir.
8. Hata kayıtları incelenir.
9. Başarılı değişiklikler canlı sisteme aktarılmak üzere değerlendirilir.

Bir testin başarılı olması, sistemin bütün özelliklerinin doğrulandığı anlamına gelmez. Her bileşen kendi işlevine göre test edilmelidir.

---

# 16. Sistemin temel tasarım ilkeleri

Kestik'in mimarisi aşağıdaki ilkeler üzerine kuruludur:

**Modülerlik:** Her işlev kendi sorumluluğuna sahip olmalıdır.

**Bağımsızlık:** Frontend, backend, veritabanı ve harici servisler birbirinden ayrılmalıdır.

**Güvenlik:** Gizli bilgiler yalnızca sunucu tarafında tutulmalıdır.

**Verimlilik:** Mümkün olan işlemler yapay zekâ kullanmadan mevcut verilerle gerçekleştirilmelidir.

**Önbellekleme:** Tekrarlanan pahalı araştırma ve analiz işlemleri gereksiz yere yeniden yapılmamalıdır.

**Yedeklilik:** Yapay zekâ servislerinde uygun yedek sağlayıcı kullanılabilmelidir.

**Doğrulanabilirlik:** Her önemli işlem test edilebilir ve hata kayıtlarıyla izlenebilir olmalıdır.

**Ortam ayrımı:** Test ve canlı sistemlerin kaynak kodları, secret değerleri ve veritabanları birbirine karıştırılmamalıdır.

---

# 17. Sonuç

Kestik, yalnızca TMDB üzerinden film arayan basit bir web uygulaması değildir.

Hugging Face üzerinde çalışan kullanıcı arayüzü, GitHub üzerinde tutulan modüler backend kaynak kodu, Vercel üzerinde çalışan Node.js fonksiyonları, Cloudflare entegrasyonları, Turso veritabanı, farklı film veri kaynakları, yapay zekâ modelleri ve görsel analiz altyapısını bir araya getiren çok bileşenli bir sistemdir.

Bu mimarinin temel hedefi; film keşfini daha kapsamlı, filtrelemeyi daha esnek, film araştırmasını daha güçlü ve görsel analizini daha kullanışlı hale getirmektir.

Sistemin sürdürülebilir biçimde geliştirilebilmesi için her bileşenin kendi sorumluluğunu koruması, test ve canlı ortamların ayrılması ve değişikliklerin doğrulanarak aktarılması gerekir.
