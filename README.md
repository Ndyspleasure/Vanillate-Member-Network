# Vanillate Member Network

Aplikasi mandiri untuk menemukan dan mempromosikan komunitas Discord. Backend dan bot REST menggunakan Discord Application tersendiri. Tidak menjalankan, mengimpor, atau mengubah bot utama Vanillate.ID.

## Fitur

- Katalog publik, filter bahasa/minat, serta rekomendasi berdasarkan minat anggota.
- OAuth2 Discord Authorization Code Flow dengan `identify guilds.join`, state sekali pakai dan sesi HttpOnly.
- Persetujuan eksplisit per komunitas, berlaku 30 hari untuk satu kali bergabung. Pendaftaran tidak memberikan persetujuan ke seluruh campaign.
- Panel anggota untuk minat, riwayat, pencabutan persetujuan dan disconnect.
- Panel admin: anggota aktif/nonaktif, komunitas dan moderasi, campaign mulai/jeda/selesai, hasil, analitik agregat dan audit aktivitas.
- Worker persisten, klaim job atomik, token terenkripsi AES-256-GCM, refresh/revoke, retry terbatas untuk rate limit, dan status `unknown` untuk hasil jaringan ambigu.
- PostgreSQL/Supabase dengan schema privat, RLS dan hak akses browser ditutup. Tidak membuat project Supabase baru.

## Target deployment: Wispbyte

Gunakan [panduan Wispbyte](docs/wispbyte.md). Entry point `index.js`, Node.js 24+, port dari `PORT` atau `SERVER_PORT`. Paket upload tersedia sebagai artifact CI `member-network-wispbyte-source`.

## Menjalankan

Persyaratan: Node.js 24+, PostgreSQL existing yang sesuai untuk layanan, Supabase Auth CMS, dan Discord Application baru.

```sh
npm ci
cp .env.example .env
# Isi konfigurasi backend di .env. Jangan commit file tersebut.
npm run db:migrate
# Provision login database runtime terpisah sesuai panduan Wispbyte.
npm run preflight
npm start
```

Katalog dan panel anggota: `APP_BASE_URL/`. Panel pengelolaan: `APP_BASE_URL/admin`.

Jangan menjalankan migrasi ke database produksi sebelum meninjau SQL dan mengambil backup. Perintah migrasi hanya dijalankan secara eksplisit, bukan otomatis ketika aplikasi start. Tidak ada data contoh yang diisikan ke database runtime.

`ADMIN_USER_IDS` dan `VIEWER_USER_IDS` adalah daftar UUID pengguna Supabase Auth, dipisahkan koma. Daftar ini menetapkan otorisasi Member Network di backend. Akun Supabase biasa tidak otomatis mendapat akses. Token diverifikasi di Supabase Auth pada setiap request admin. Sesi login panel tidak melebihi satu jam atau masa token.

`AUTO_JOIN_ENABLED=false` adalah default. Aktifkan hanya setelah bot, izin server dan alur consent diuji di server uji. Tidak ada self-bot atau token akun Discord biasa.

## Pengujian

```sh
npm run check
npm test
# Chromium lokal diperlukan. Set CHROMIUM_PATH bila lokasi berbeda.
npm run test:browser
# PostgreSQL terisolasi nyata bernama member_network_test:
npm run test:postgres
```

Tes memakai PostgreSQL in-memory PGlite dan layanan Discord/Supabase Auth tiruan. Pengujian browser menjalankan server lokal sementara dan data sintetis. Tidak membutuhkan atau menyentuh kredensial produksi. Hasil live OAuth, join Discord, TLS database host, dan pemasangan ke website CMS existing tetap perlu acceptance test operator.

## Dokumentasi

- [Deployment, konfigurasi Discord dan maintenance](docs/deployment.md)
- [API dan integrasi CMS](docs/api.md)
- [Implementasi, keamanan dan batas verifikasi](docs/implementation.md)
- [Rancangan awal Stage 1](docs/stage-1-architecture.md)
- [Laporan perkembangan](claudereport.md)

Status: source disiapkan untuk deployment Wispbyte dengan pengujian lokal dan CI. Belum dideploy dan belum disambungkan ke Discord atau database produksi. Hosting, application dan secret perlu dikonfigurasi operator.
