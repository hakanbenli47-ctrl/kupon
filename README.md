# Kupon Analiz

## V5 — 2026–27 sezon operasyon merkezi

- Ana sayfa ve `/akilli-kupon` artık tek ve tamamen yeniden yazılmış, mobil uyumlu Fikstür/Lab arayüzünü açar. Oynanacak, oynanan, sezonun tamamı; lig ve takım araması, sayfalandırma, her maçın kaynak bağlantısı, veri kapsamı ve model analizi bulunur.
- `/api/season` 1 Temmuz 2026–1 Temmuz 2027 arasında veritabanına kaydedilmiş tüm fikstür ve maç sonuçlarını sayfalayarak sunar; 40 maç/sayfa. Oynanan sonuçlar `FINISHED` durumuna göre sınıflandırılır.
- `/api/season/coverage` lig bazında oynanan, planlanan, doğrulanmış gol olayları, detay istatistik sayıları ve kaynağın gerçek durumunu gösterir. **Kaynağı tamamlanmış gibi işaretlemek ile içe aktarımın bitmesi aynı şey değildir.**
- `/api/season/sync` kullanıcı isteğiyle 2026/27 kaynaklarından sınırlı sayıda bölümü işler; mevcut kaynak hatalarını da ayrıntılı raporlar. Üretimde Vercel `/api/cron/season` ile günlük kontrol yapılır, ilerleme `season_sync_progress` tablosunda saklanır.
- Bundesliga, 2. Bundesliga ve 3. Liga: OpenLigaDB'de `bl1/bl2/bl3/2026` sezon snapshotları; tamamlanmış maçlarda `matchIsFinished` ve **yalnızca 90 dakika final skoru** doğrulanır. Gol dakikaları yalnızca olaylar toplam skorla eşleştiğinde eklenir.
- Türkiye 1., 2., 3. Lig: TFF'nin lig/grup ve hafta bazlı sayfaları taranır; grup kimlikleri bu sezondan keşfedilir. Saati veya skoru kaynaktan doğrulanamayan karşılaşma için uydurma saat/skor yazılmaz. TFF sayfa yapısı değişirse hata verilir ve ilerleme korunur.
- Premier League, La Liga, Süper Lig ve Serie A: ESPN'in desteklediği sezon tarih aralıkları sorgulanır. ESPN arayüzü gayriresmîdir ve bazı lig/tarih aralıkları eksik kalabilir; bunun kanıtı olmayan bilgi tam kabul edilmez.
- Başlangıçta bulunan 1.066 adet statik 2026/27 fikstürü (Süper Lig 306, La Liga 380, Premier League 380) aynen tutulur. **Tohum verisi güncel skorları veya başlangıç saatini artık sıfırlayamaz.**
- Çok fazla kayıt alınana kadar tam sezon kapsamı **garanti edilmez**. Lig bazında gerçek aktarım adımları ile kaynakların eksikleri görünür; tamamlanmış veri oranı veya geçmiş maç isabeti sahte üretilmez.
- Algoritma V4'teki geriye dönük sınamayı kullanır. 10.000 simülasyon yeni bilgi üretmez, skor modelinin olasılıklarını örnekler. Bahis kararı veya banko garantisi değildir.

Test: `npm run test:season`, `npm run test:v4`, `npm run test:optimizer`, `npx tsc --noEmit`.


## Kupon Motoru V4 — sıfırdan skor olasılığı analizi

- `/akilli-kupon` artık ayrı bir V4 hesaplama motoruna bağlıdır. Eski V2.x olasılık yöntemleri yeni maçlara uygulanmaz.
- Kaynaklı maç sonuçlarından 365 günlük lig geçmişi, iç/deplasman hücum ve savunma, ağırlıklı son form ve uygunsa xG istatistikleri kullanılır. Yetersiz veya şüpheli veri **tahmine dönüşmez**.
- Tam skor matrisi (Poisson + düşük skor bağımlılığı), 1X2, çifte şans, alt/üst 1.5–3.5 ve KG pazarı aynı matristen hesaplanır.
- 10.000 simülasyon her maç için üretilir, fakat tahmin sıralamasında analitik olasılık kullanılır. Bu simülasyon yeni bilgi veya test değildir.
- Sadece aynı gün ve Türkiye yerel saati tam olarak aynı maçlardan kupon grubu oluşur; 5–6 yeterli maç yoksa sistem kuponu zorla tamamlamaz.
- Veri kalite puanı **isabet oranı değildir**. Alt/üst seçimlerine veri eksikliğine dayalı risk indirimi uygulanır.
- Bir maç için gerçek bahis oranını kullanıcı girerse modelin hesaplanan adil oranı ve beklenen değer karşılaştırılabilir; canlı oran/garanti kâr servisi yoktur.
- Gerçek isabet, `/api/v4/backtest` aracılığıyla kronolojik dış örneklem testinde Brier skoru, log loss, 1X2 ve 2.5 gol isabetiyle ölçülür. Lig için yeterli test maçı bulunmazsa güvenilir başarı iddiası yoktur.
- Otomatik skor sonuçları, geçmiş veri aktarma cursorları ve eski kupon tarihçesi korunur. Geçmiş maçlar cron ile kademeli tamamlanır; her ligin tam veri kapsamı garanti edilmez.
- Model testleri `npm run test:v4`, mevcut kupon entegrasyonu testleri `npm run test:optimizer` ve TypeScript doğrulaması `npx tsc --noEmit`.


## Akıllı Kupon Laboratuvarı (v2.2)

- `/akilli-kupon` ekranında bugün/yarın/tarih, 2–6 maç, üst/alt, veri kalitesi filtresi ve 10.000 senaryoluk gösterim bulunur.
- 1.5, 2.5, 3.5 gol piyasalarında mevcut model tahminlerini değerlendirir. Alternatif alt/üst sonuçları ham Poisson dağılımıdır ve kalibrasyonsuz olarak işaretlenir.
- Her maçtan bir bahis seçilir; zayıf istatistik kapsamı olan maçlar filtrelenir ve kupon sayısını doldurmak için tekrar ya da zayıf maç eklenmez.
- Olasılıklara veri kalitesine bağlı temkinlilik indirimi uygulanır. Bu bir istatistiksel güven aralığı ya da gerçek kazanma garantisi değildir.
- Gerçek bahis oranları henüz entegre edilmediği için kullanıcı oranları girince beklenti (EV), adil oran ve varsayımsal ödeme hesaplanır; gerçek bahis oynamaz.
- Uygun istatistik yoksa hiçbir kupon önermemek normaldir. Modelin tarihî testleri, kalibrasyon ve gerçek piyasa oranları olmadan sürekli kazanç vaadi yapılamaz.
- Temel test: `npm run test:optimizer`.


Turso üzerinde kalıcı veri havuzu kullanan, 31 günlük fikstürü analiz eden gol tahmin paneli. Yalnızca 1.5, 2.5 ve 3.5 Alt/Üst piyasalarını değerlendirir. Tahminler garanti değildir.

## Veri ve çalışma düzeni

- Üretim veritabanı: Turso (`TURSO_DATABASE_URL` ve `TURSO_AUTH_TOKEN`)
- Manuel giriş koruması: `MANUAL_ENTRY_TOKEN`
- Yerel yedek: `data/kupon.db` ve `data/backups/`
- Şema ve otomatik geçişler: `lib/schema.sql`, `lib/db.ts`
- UEFA fikstür/sonuç güncellemesi: `node scripts/update-uefa.mjs`
- Güncel UEFA fikstür keşfi: resmî eleme sayfalarındaki maç kimliklerini günlük bulut işleminde tarar
- UEFA takım kimliğiyle son maç, gol olayı ve resmî maç istatistiği tamamlama: günlük bulut otomasyonu
- Resmî 2026/27 Premier Lig, La Liga ve Süper Lig fikstürü: `scripts/import-official-schedules.py`
- Ulusal lig geçmişi: `node scripts/import-domestic-history.mjs`
- Doğrulanmış JSON içe aktarma: `node scripts/ingest-fixtures.mjs data/imports/guncel.json`
- Ayrıntılı tarihî CSV: `node scripts/import-football-data.mjs <CSV_URL> <PL|TSL|LL>`

Her fikstürde HTTPS kaynak bağlantısı ve kontrol zamanı zorunludur. Bulunmayan istatistik uydurulmaz. Tarihi kesinleşmeyen maçlar `TBC`, ertelenenler `POSTPONED` olarak tutulur.

## Model 2.1 — gol zamanlaması

Model yalnızca son beş maçın gol toplamına bakmaz:

- En yeni maça daha yüksek ağırlık veren son beş genel form
- Ev/deplasman performansı ve lig gol ortalaması
- Mevcutsa düşük ağırlıklı H2H geçmişi
- Şut, isabetli şut, rakibe verilen isabetli şut, korner ve topa sahip olma
- Atak, pas isabeti, tamamlanan/denenen pas, top kazanma ve kurtarış
- Mevcutsa xG ve büyük şans
- Yalnızca doğrulanmış sakat ve cezalı oyuncu etkileri
- Son maçlardaki gol atma/yeme dakikaları, ilk yarı ve 76+ dakika gol oranları
- Poisson toplam gol olasılığı ve sonuçlardan ampirik kalibrasyon

Her tahminde ayrıntılı istatistik ve gol dakikası kapsamı ayrıca saklanır. Gol olaylarının ev/deplasman sayıları resmî skorla tam olarak uyuşmuyorsa dakika verisi eksik kabul edilir ve modele katılmaz. Zamanlama sinyali aşırı uyumu önlemek için beklenen gole sınırlı bir etki yapar. Veri eksikliği kalite puanını düşürür. Kupon Robotu maç başına tek seçim kullanır ve analizi hazır olan günün bütün maçlarını 4–5 maçlık gruplara dağıtır. Her seçimi en fazla bir kez kullanır; yalnızca 4–7 analiz bulunduğunda son grubun dört maça tamamlanması için en güçlü seçimlerden sınırlı tekrar yapar. Gruptaki bütün seçimler `%78` olasılık ve `%75` veri kalitesi eşiğini geçiyorsa kupon `Banko`, aksi durumda `Alternatif` olarak etiketlenir.

## Günlük bulut otomasyonu

Vercel Cron her gün `02:00 UTC` (Türkiye saatiyle yaklaşık `05:00`) `/api/cron/daily` yolunu çağırır. Bilgisayarın açık olması gerekmez. Günlük işlem:

1. Resmî UEFA eleme sayfalarındaki yeni maç kimliklerini keşfeder ve 31 günlük pencereye ekler.
2. Yakın zamanda oynanan maçları UEFA Match Centre ve ücretsiz TheSportsDB verileriyle kontrol eder.
3. Yaklaşan UEFA maçlarındaki iki takımın ayrı ayrı son beş bitmiş maçını takım kimliğiyle tamamlar.
4. Resmî UEFA maç istatistiğinden şut, isabetli şut, korner, faul ve kart verilerini alır.
5. Gol dakikalarını resmî normal süre skoruyla doğrular; uzatma devresi gollerini 90 dakika pazarına katmaz.
6. Manuel girilmiş skorları korur.
7. Sonuçlanan tahmin ve kuponları kapatır.
8. 31 günlük analizleri ve günün kuponlarını yeniden üretir.

`CRON_SECRET` tanımlanırsa cron yolu Bearer anahtarıyla korunur. Aynı gün içindeki yinelenen çağrılar `cloud_sync_locks` tablosuyla tekilleştirilir.

## Manuel veri koruması

Panelde kupon maçlarının skorları ve `Tuttu` / `Tutmadı` sonucu yönetici anahtarıyla girilebilir. Bunlar `manual_fixture_results` ve `manual_coupon_reviews` tablolarında ayrı tutulur. Otomatik fikstür güncellemesi manuel skorların üzerine yazamaz.

Canlı ortamda `MANUAL_ENTRY_TOKEN` tanımlı değilse manuel kayıt API’si kapalı kalır. Anahtar yalnızca kullanıcının tarayıcısında saklanır ve istek başlığında gönderilir.

## 15 günlük bakım

Otomasyon her 15 günde bir saat 21:14’te:

1. Turso'nun şema ve bütün tablo satırlarını içeren mantıksal JSON yedeğini alır.
2. Kullanıcının manuel kayıtlarına dokunmadan fikstür, sonuç ve takım geçmişini yeniler.
3. Ücretsiz ve doğrulanabilir kaynaklarda bulunan ayrıntılı performans verilerini ve oyuncu durumlarını günceller.
4. Takım adlarını tekilleştirir, yinelenen veya tutarsız kayıtları denetler.
5. 31 günlük analizleri, kuponları ve tamamlanan sonuçları yeniden hesaplar.
6. Lint, TypeScript ve production build kontrollerinden sonra canlı dağıtımı doğrular.

## Kaynak politikası

Fikstür ve sonuçlarda UEFA, Premier League, TFF ve RFEF/La Liga gibi resmî sayfalar; tarihî veride açık lisanslı kaynaklar kullanılır. Ayrıntılı veriler yalnızca kullanımına izin verilen ücretsiz veya resmî kaynaklardan alınır. Maçkolik/Bilyoner sayfaları otomatik kazınmaz.
