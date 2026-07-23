# Kupon Analiz

Turso üzerinde kalıcı veri havuzu kullanan 31 günlük gol tahmin paneli. Yalnızca 1.5, 2.5 ve 3.5 Alt/Üst piyasalarını değerlendirir. Tahminler garanti değildir.

## Başlatma

`baslat.cmd` dosyasına çift tıklayın. Panel `http://localhost:3000` adresinde açılır.

## Veri düzeni

- Üretim veritabanı: Turso (`TURSO_DATABASE_URL` ve `TURSO_AUTH_TOKEN`)
- Yerel yedek veritabanı: `data/kupon.db`
- Şema: `lib/schema.sql`
- Fikstür içe aktarma örneği: `data/imports/example-fixtures.json`
- UEFA fikstür/sonuç güncellemesi: `node scripts/update-uefa.mjs`
- Resmî 2026/27 PL, La Liga ve Süper Lig fikstürü: `scripts/import-official-schedules.py`
- 2025/26 ulusal lig geçmişi: `node scripts/import-domestic-history.mjs`
- Doğrulanmış fikstür içe aktarma: `node scripts/ingest-fixtures.mjs data/imports/guncel.json`
- Tarihî CSV içe aktarma: `node scripts/import-football-data.mjs <CSV_URL> <PL|TSL|LL>`

Her fikstürde HTTPS kaynak bağlantısı zorunludur. Tarihi/saati kesinleşmeyen maçlar `TBC`, ertelenenler `POSTPONED` olarak kaydedilir. Oyuncu etkisi yalnızca doğrulanmış kaynak ve açık etki değeri varsa kullanılır; eksik bilgi uydurulmaz.

## Analiz kuralları

- Maçtan önce oynanan son 5 karşılaşma
- Son 5 içinde lig, kupa ve UEFA maçlarının tamamı; sezon değişimi filtrelenmez
- Ev/deplasman performansı
- Son 5 H2H karşılaşması (düşük ağırlık)
- Lig gol ortalaması
- Şut, isabetli şut, korner, faul, kart ve mevcutsa topa sahip olma verisi
- Doğrulanmış sakat ve cezalı oyuncular
- Poisson toplam gol modeli ve sonuçlardan kalibrasyon

Kupon için maç başına tek seçim kullanılır. En az dört maçın %72 olasılık ve %65 veri kalitesi eşiğini geçmesi gerekir. Yeterli maç yoksa kupon oluşturulmaz.

Kupon Robotu hazır kuponları, cihazda seçilen kuponları ve sonuç geçmişini ayrı gösterir. Bitmiş maçların skorları tahminleri ve kupon durumunu otomatik olarak `Tuttu`/`Tutmadı` şeklinde sonuçlandırır.

## Ücretsiz veri kaynakları

- Fikstürler: UEFA, Premier League, TFF ve RFEF/La Liga resmî sayfaları
- Tarihî lig sonuçları: OpenFootball CC0
- Oyuncu durumu: kulüp ve organizasyonların doğrulanabilir resmî açıklamaları

Maçkolik/Bilyoner sayfaları otomatik kazınmaz. Kaynak sayfalarının koşulları ve atıf bilgileri korunur.
