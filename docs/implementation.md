# Implementasi MVP dan batas verifikasi

> Pembaruan readiness Wispbyte: lihat [panduan deployment Wispbyte](wispbyte.md). Entry point panel bot, port allocation, preflight, role DB khusus, upgrade schema, penghapusan/retensi, keyring/rotasi dan pengujian PostgreSQL nyata kini tersedia. Catatan keterbatasan versi MVP di bawah adalah histori awal dan digantikan rincian terbaru di panduan tersebut.

Implementasi ini melanjutkan rancangan Stage 1 dengan aplikasi yang dapat dijalankan, bukan hanya mockup. Keputusan implementasi yang berbeda dari rencana awal dicatat di sini; dokumen Stage 1 tetap menjadi catatan historis.

## Komponen yang tersedia

| Komponen            | Implementasi                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime mandiri     | Node.js 24, JavaScript ESM, Fastify, Zod, PostgreSQL async                                                                                      |
| Discord bot         | Bot REST mandiri untuk verifikasi application/guild dan Add Guild Member, tanpa Gateway/intents                                                 |
| Autentikasi anggota | Authorization Code Flow identify guilds.join, state hash, browser binding, expiry, callback sekali pakai                                        |
| Sesi                | Token opaque random disimpan sebagai hash, cookie HttpOnly, expiry server; credential admin terenkripsi                                         |
| Credential Discord  | AES-256-GCM dengan nonce unik dan AAD per anggota, refresh di bawah row lock                                                                    |
| Authorization admin | Identitas diverifikasi lewat Supabase Auth, UUID allowlist server; viewer hanya data nonidentitas/agregat                                       |
| Database            | Schema non-exposed member_network, RLS seluruh tabel, revoke akses PUBLIC/anon/authenticated; SQL parameterized                                 |
| Worker              | Persistent jobs, unique campaign/member dan consent, claim atomik dengan lease, retry429 dan global backoff, unknown untuk timeout/crash ambigu |
| Consent             | Exact komunitas, berlaku 30 hari dan satu kali join, revocation membatalkan job, reconnect tidak menghidupkan izin lama                         |
| UI anggota          | Katalog, filter, minat, rekomendasi dengan alasan, consent/revoke/disconnect, riwayat                                                           |
| UI admin            | Ringkasan, anggota aktif/nonaktif, komunitas pending/approved/suspended, campaign start/pause/complete dan daftar hasil, analitik dan audit     |
| CMS adapter         | Bearer JWT Supabase CMS, origin allowlist, tanpa cookie lintas origin atau secret frontend                                                      |
| Operasi             | Env kosong, Docker non-root, health checks, migration runner checksum, cleanup, workflow CI                                                     |

Rencana TypeScript diganti JavaScript ESM dengan validasi Zod di semua input publik. Tabel berada pada schema privat tersendiri, bukan menambah tabel publik mn\_\*. Ini mengurangi permukaan Data API. API aktual memakai prefix `/api`, bukan `/v1/member-network`. Worker ada di proses layanan yang sama untuk satu replika awal; tidak bergantung pada bot utama.

Panel admin sendiri memakai sesi Supabase Auth CMS dan hak akses khusus layanan. Menu/halaman dalam website CMS existing belum dipasang; adapter siap untuk integrasi pada repo website terpisah. Semua operasi community/campaign dikelola admin yang ditetapkan operator. Portal mandiri untuk administrator server umum dan verifikasi individu melalui Discord belum dibuat, sehingga endpoint admin tidak boleh diberi akses ke pendaftar umum.

## Bukti pengujian

- Pemeriksaan sintaks JavaScript dan whitespace diff.
- Tes Node terhadap PostgreSQL PGlite: RLS/grants, idempotensi schema, OAuth state binding/expiry/replay/scope, token encryption/context/tamper, admin auth, viewer/outsider/CSRF, input dan error redaction, consent, campaign uniqueness, worker state checks, refresh, existing member/screening, rate limit, hasil ambigu, disconnect/revoke retry.
- Adapter Discord diuji untuk bot Authorization, token exchange/refresh, scope guilds.join, HTTP201/204/pending/429. Endpoint dan persyaratan Add Guild Member dicocokkan dengan dokumentasi resmi Discord.
- Browser Chromium dengan layanan eksternal tiruan menjalankan admin login, create/approve community, callback OAuth, member consent, create/start campaign, worker success, revoke consent, serta desktop 1440px dan mobile390px tanpa overflow halaman atau JavaScript error.
- Instalasi ulang dari lockfile dan npm audit dependency produksi dilakukan lokal. Hasil akhir run dicatat di claudereport.md dan PR.

Tes browser memperbaiki dua masalah yang ditemukan: layout navigation mobile dan Content-Type JSON pada DELETE tanpa body. Data browser sintetis hanya ada di database in-memory test, tidak menjadi fallback runtime.

## Batas penting

Belum ada application Discord baru, token produksi, migration produksi atau deployment live yang dijalankan. Tes eksternal memakai tiruan; hasilnya tidak membuktikan izin guild, consent OAuth live, TLS host, email/password Supabase produksi atau kuota aktual. Tidak ada perubahan ke bot utama, database pemain atau website CMS existing.

PGlite menguji PostgreSQL SQL/constraints tetapi bukan bukti konkurensi multi-replika dengan host PostgreSQL nyata. Jalankan satu replika dahulu. Rate limiter HTTP per proses, penerusan proxy sengaja tidak dipercaya otomatis. Worker memerlukan pengujian row lock/network pada PostgreSQL staging sebelum scale-out.

Pending screening tidak otomatis berubah menjadi added; tidak ada Gateway membership observer. Hasil unknown perlu rekonsiliasi manual; aplikasi tidak mencoba lagi secara buta atau menghitungnya sebagai konversi. Tidak ada auto-rejoin dari consent yang sama ketika pengguna meninggalkan server.

Analitik adalah agregat hasil job 30 hari, bukan estimasi impressions atau klik pemasaran. Query sesuai permintaan, tanpa polling UI. Tidak ada ML, scraping profil, broadcast DM atau penambahan scope email/guilds.

Consent langsung tidak otomatis membuat job; admin memulai campaign. Start mengambil snapshot anggota yang consent saat itu dan dapat diulang untuk anggota baru sampai batas campaign. Keunikan DB menjaga anggota/consent tidak masuk dua kali. Saat pause/revoke menunggu request Discord yang sudah berjalan, permintaan yang telah diterima Discord tidak dapat dibatalkan.

State/sesi expired dan audit90hari memiliki cleanup eksplisit. Retensi member/job, hak hapus data, rotasi key multiversi otomatis, alert operasional dan restore/reconciliation masih memerlukan pengembangan atau prosedur operator sebelum peluncuran publik berskala besar.

Kunci enkripsi tunggal dan DB backend harus dijaga terpisah. Batasi grants role runtime ke schema layanan. Tidak ada service-role key, bot token atau client secret di frontend. Tidak ada audit keamanan internal dari proyek lain yang dipublikasikan dalam repo ini.
