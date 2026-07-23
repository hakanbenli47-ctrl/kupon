# Kupon Analiz

Turso üzerinde kalıcı veri havuzu kullanan, 31 günlük fikstürü analiz eden gol tahmin paneli. Yalnızca 1.5, 2.5 ve 3.5 Alt/Üst piyasalarını değerlendirir. Tahminler garanti değildir.

## Veri ve çalışma düzeni

- Üretim veritabanı: Turso (`TURSO_DATABASE_URL` ve `TURSO_AUTH_TOKEN`)
- Manuel giriş koruması: `MANUAL_ENTRY_TOKEN`
- Yerel yedek: `data/kupon.db` ve `data/backups/`
- Şema ve otomatik geçişler: `lib/schema.sql`, `lib/db.ts`
- UEFA fikstür/sonuç güncellemesi: `node scripts/update-uefa.mjs`
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

Her tahminde ayrıntılı istatistik ve gol dakikası kapsamı ayrıca saklanır. Gol olaylarının ev/deplasman sayıları resmî skorla tam olarak uyuşmuyorsa dakika verisi eksik kabul edilir ve modele katılmaz. Zamanlama sinyali aşırı uyumu önlemek için beklenen gole sınırlı bir etki yapar. Veri eksikliği kalite puanını düşürür. Kupon Robotu maç başına tek seçim kullanır; en az dört seçim `%72` olasılık ve `%68` veri kalitesi eşiğini geçmezse kupon üretmez. Günlük en fazla iki adet, 4–5 maçlık kupon oluşturur.

## Günlük bulut otomasyonu

Vercel Cron her gün `02:00 UTC` (Türkiye saatiyle yaklaşık `05:00`) `/api/cron/daily` yolunu çağırır. Bilgisayarın açık olması gerekmez. Günlük işlem:

1. Yakın zamanda oynanan maçları UEFA Match Centre ve ücretsiz TheSportsDB verileriyle kontrol eder.
2. Yaklaşan UEFA maçlarındaki iki takımın ayrı ayrı son beş bitmiş maçını takım kimliğiyle tamamlar.
3. Resmî UEFA maç istatistiğinden şut, isabetli şut, korner, faul ve kart verilerini alır.
4. Gol dakikalarını resmî normal süre skoruyla doğrular; uzatma devresi gollerini 90 dakika pazarına katmaz.
5. Manuel girilmiş skorları korur.
6. Sonuçlanan tahmin ve kuponları kapatır.
7. 31 günlük analizleri ve günün kuponlarını yeniden üretir.

`CRON_SECRET` tanımlanırsa cron yolu Bearer anahtarıyla korunur. Aynı gün içindeki yinelenen çağrılar `cloud_sync_locks` tablosuyla tekilleştirilir.

## Manuel veri koruması

Panelde kupon maçlarının skorları ve `Tuttu` / `Tutmadı` sonucu yönetici anahtarıyla girilebilir. Bunlar `manual_fixture_results` ve `manual_coupon_reviews` tablolarında ayrı tutulur. Otomatik fikstür güncellemesi manuel skorların üzerine yazamaz.

Canlı ortamda `MANUAL_ENTRY_TOKEN` tanımlı değilse manuel kayıt API’si kapalı kalır. Anahtar yalnızca kullanıcının tarayıcısında saklanır ve istek başlığında gönderilir.

## 15 günlük bakım

Otomasyon her 15 günde bir saat 21:14’te:

1. Turso yedeğini alır.
2. Kullanıcının manuel kayıtlarına dokunmadan fikstür, sonuç ve takım geçmişini yeniler.
3. Ücretsiz ve doğrulanabilir kaynaklarda bulunan ayrıntılı performans verilerini ve oyuncu durumlarını günceller.
4. Takım adlarını tekilleştirir, yinelenen veya tutarsız kayıtları denetler.
5. 31 günlük analizleri, kuponları ve tamamlanan sonuçları yeniden hesaplar.
6. Lint, TypeScript ve production build kontrollerinden sonra canlı dağıtımı doğrular.

## Kaynak politikası

Fikstür ve sonuçlarda UEFA, Premier League, TFF ve RFEF/La Liga gibi resmî sayfalar; tarihî veride açık lisanslı kaynaklar kullanılır. Ayrıntılı veriler yalnızca kullanımına izin verilen ücretsiz veya resmî kaynaklardan alınır. Maçkolik/Bilyoner sayfaları otomatik kazınmaz.
