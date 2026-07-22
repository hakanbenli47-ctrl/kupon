# Kupon Analiz

Yerel çalışan, SQLite tabanlı 15 günlük gol tahmin paneli. Yalnızca 1.5, 2.5 ve 3.5 Alt/Üst piyasalarını değerlendirir. Tahminler garanti değildir.

## Başlatma

`baslat.cmd` dosyasına çift tıklayın. Panel `http://localhost:3000` adresinde açılır.

## Veri düzeni

- Veritabanı: `data/kupon.db`
- Şema: `lib/schema.sql`
- Fikstür içe aktarma örneği: `data/imports/example-fixtures.json`
- UEFA fikstür/sonuç güncellemesi: `node scripts/update-uefa.mjs`
- Doğrulanmış fikstür içe aktarma: `node scripts/ingest-fixtures.mjs data/imports/guncel.json`
- Tarihî CSV içe aktarma: `node scripts/import-football-data.mjs <CSV_URL> <PL|TSL|LL>`

Her fikstürde HTTPS kaynak bağlantısı zorunludur. Tarihi/saati kesinleşmeyen maçlar `TBC`, ertelenenler `POSTPONED` olarak kaydedilir. Oyuncu etkisi yalnızca doğrulanmış kaynak ve açık etki değeri varsa kullanılır; eksik bilgi uydurulmaz.

## Analiz kuralları

- Maçtan önce oynanan son 5 karşılaşma
- Ev/deplasman performansı
- Son 5 H2H karşılaşması (düşük ağırlık)
- Lig gol ortalaması
- Şut, isabetli şut, korner, faul, kart ve mevcutsa topa sahip olma verisi
- Doğrulanmış sakat ve cezalı oyuncular
- Poisson toplam gol modeli ve sonuçlardan kalibrasyon

Kupon için maç başına tek seçim kullanılır. En az dört maçın %72 olasılık ve %65 veri kalitesi eşiğini geçmesi gerekir. Yeterli maç yoksa kupon oluşturulmaz.

## Ücretsiz veri kaynakları

- Fikstürler: UEFA, Premier League, TFF ve La Liga resmî sayfaları
- Tarihî lig sonuçları: football-data.co.uk CSV dosyaları
- Oyuncu durumu: kulüp ve organizasyonların doğrulanabilir resmî açıklamaları

Maçkolik/Bilyoner sayfaları otomatik kazınmaz. Kaynak sayfalarının koşulları ve atıf bilgileri korunur.
