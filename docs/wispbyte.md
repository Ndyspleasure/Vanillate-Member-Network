# Ready-to-deploy: Wispbyte

Paket ini adalah satu service Node.js dan satu bot REST Member Network. Gunakan server Wispbyte tersendiri, bukan server bot utama. Tidak memerlukan Docker-in-Docker atau PM2 di panel Wispbyte.

## 1. Persiapan panel

- Pilih runtime **Node.js 24 atau lebih baru**. Jangan memakai Node.js 20/22 untuk package ini.
- Unggah source dari artifact GitHub Actions `member-network-wispbyte-source`, atau ekstrak Source code ZIP repository sehingga `index.js` dan `package.json` berada langsung di root server.
- Install dependencies dengan `npm ci --omit=dev`. Bila startup panel menjalankan instalasi sendiri, tetap gunakan lockfile dan jangan menghapusnya.
- Entry point/JS_FILE: `index.js`. Startup: `node index.js` atau `npm start`, sesuai field startup yang diberikan panel.
- Bind sudah diatur ke `0.0.0.0`. Biarkan PORT kosong bila panel menyediakan SERVER_PORT; aplikasi akan memakai SERVER_PORT. Bila tidak ada SERVER_PORT, isi PORT dengan **primary allocation port** yang benar-benar tampil di panel. Tidak harus 3000.
- Atur subdomain dari panel Wispbyte dan pastikan HTTPS bekerja menuju primary allocation port. APP_BASE_URL adalah origin HTTPS subdomain, tanpa port internal, path, query atau fragment. Jangan memakai IP HTTP sebagai URL OAuth produksi.

Referensi platform: [Server Management](https://wispbyte.com/kb/server-management), [Subdomains](https://wispbyte.com/kb/subdomains), [Getting Started](https://wispbyte.com/kb/getting-started). URL subdomain, alokasi port dan ketersediaan Node.js pada akun pengguna belum diperiksa langsung. Bila subdomain menunjukkan ACTIVE tetapi HTTPS gagal, selesaikan routing/TLS melalui panel/support sebelum mengaktifkan OAuth; aplikasi tidak menurunkan keamanan cookie atau HTTPS untuk mengakalinya.

## 2. Discord Application baru

Buat **Vanillate Member Network** di Discord Developer Portal. Isi Application ID/Client ID, Client Secret dan Bot Token hanya pada environment panel atau `.env` privat. ID aplikasi dan client harus sama; bot dari aplikasi lain ditolak saat startup.

Set OAuth redirect exact `APP_BASE_URL/auth/discord/callback` pada portal. Instal bot ke server uji dengan `bot applications.commands` dan permission **Create Instant Invite**. OAuth pengguna memakai `identify guilds.join`. Tidak membutuhkan token akun biasa, Message Content atau privileged Gateway intents. Bot menggunakan REST sehingga tidak harus terlihat online di daftar anggota untuk menjalankan join.

## 3. Database dan izin runtime

Gunakan database Supabase CMS existing yang telah diperiksa. Tidak membuat project baru dan tidak memakai database pemain. Backup sebelum migration produksi.

1. Dari mesin administrasi terpercaya, isi MIGRATION_DATABASE_URL dengan koneksi role migrasi, lalu jalankan `npm run db:migrate`. Runner memverifikasi checksum initial schema yang sudah ada dan menerapkan upgrade baru dalam transaksi.
2. Operator database membuat login PostgreSQL khusus layanan dengan LOGIN, INHERIT, tanpa SUPERUSER, CREATEDB, CREATEROLE atau BYPASSRLS. Jangan gunakan akun postgres sebagai DATABASE_URL runtime.
3. Isi RUNTIME_DATABASE_ROLE dengan nama login tersebut dan jalankan `npm run db:provision-runtime` memakai MIGRATION_DATABASE_URL. Skrip memberi akses hanya ke schema member_network dan RLS policy khusus group backend. Tidak membuka akses anon/authenticated.
4. Simpan koneksi login terbatas tersebut sebagai DATABASE_URL pada Wispbyte. Gunakan session pooler/direct connection dengan TLS serta verifikasi CA yang benar sesuai konfigurasi Supabase.
5. MIGRATION_DATABASE_URL dan RUNTIME_DATABASE_ROLE tidak diperlukan saat runtime. Hapus kredensial migrasi dari panel setelah administrasi selesai. Jangan menaruh password database di repository, build website atau chat.

## 4. Environment Wispbyte

Salin nama variabel dari `.env.example`, lalu isi di environment panel atau file `.env` privat. Nilai dari panel menang atas file `.env`.

Wajib: NODE_ENV=production, APP_BASE_URL, DATABASE_URL (role terbatas), SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DISCORD_APPLICATION_ID, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, DISCORD_REDIRECT_URI, TOKEN_ENCRYPTION_KEY dan ADMIN_USER_IDS.

ADMIN_USER_IDS/VIEWER_USER_IDS berisi UUID pengguna Supabase Auth CMS, dipisahkan koma. Keduanya dikelola operator backend, bukan pengaturan role yang bisa diubah di browser. Set CMS_ORIGIN ke exact origin website CMS bila integrasi CMS digunakan. AUTO_JOIN_ENABLED tetap **false** sampai acceptance test.

TOKEN_ENCRYPTION_KEY adalah kunci acak 32 byte dalam format 64 digit hex. Backup di secret manager terpisah dari database. SUPABASE_SERVICE_ROLE_KEY dan DISCORD_PUBLIC_KEY tidak digunakan implementasi REST ini; biarkan kosong, jangan menambahkan secret yang tidak dibutuhkan.

## 5. Preflight dan start

```sh
npm run preflight -- --offline
npm run preflight
npm start
```

Offline preflight hanya memvalidasi Node/config tanpa mencetak nilai secret. Online preflight memeriksa schema versi yang diperlukan, role runtime nonprivileged, identitas bot dan keterjangkauan Supabase Auth. Kegagalan menghasilkan exit code 1 dan nama pemeriksaan, bukan token atau raw SQL.

Setelah start, cek HTTPS `/health/ready`, `/` dan `/admin` dari browser. Startup tidak menerapkan migration otomatis dan gagal bila upgrade schema belum ada. Cleanup retensi berjalan saat boot dan setiap 24 jam, sehingga tidak perlu membuat cron terpisah di Wispbyte. Manual cleanup tetap tersedia melalui `npm run db:cleanup`.

Panel harus mempunyai mekanisme start/restart dan proses yang terus hidup. Aplikasi menutup worker/koneksi pada SIGINT/SIGTERM. Healthcheck Docker juga tersedia untuk host alternatif, tetapi Wispbyte cukup menjalankan entry point Node.

## 6. Acceptance sebelum auto-join

1. `/health/ready` berhasil melalui subdomain HTTPS, bukan hanya IP:port.
2. Login admin allowlist berhasil; viewer tidak bisa melakukan mutasi; pengguna lain ditolak.
3. Hubungkan akun Discord cadangan. Setelah OAuth, tidak ada join sampai pengguna memberi persetujuan per komunitas.
4. Daftarkan server uji yang mempunyai bot, setujui komunitas, beri consent, buat campaign. Aktifkan AUTO_JOIN_ENABLED, restart service, lalu mulai campaign.
5. Pastikan akun benar-benar masuk. Uji already_member, screening pending, izin bot hilang, rate limit dan pencabutan persetujuan.
6. Tombol Hapus data saya mencabut izin lokal segera. Identitas dihapus setelah revoke Discord berhasil. Disconnect tidak otomatis mengeluarkan pengguna dari server yang sudah diikuti.
7. Jika shared IP Wispbyte terkena limit Discord, hormati retry/backoff. Jangan memutar token atau mengulang join massal. Unknown perlu rekonsiliasi operator, tidak dianggap konversi otomatis.

## 7. Integrasi CMS existing

PR website menambahkan `/admin/member-network`, ringkasan agregat sesuai permintaan dan tautan pengelolaan anggota/komunitas/campaign/analitik. Isi repository variable PUBLIC_MEMBER_NETWORK_API_URL dengan origin HTTPS Wispbyte lalu build website. Backend harus mengizinkan CMS_ORIGIN dan UUID akun CMS yang benar.

Tidak ada token pada link, cookie lintas origin atau iframe. Panel admin mandiri dapat meminta login ulang. Menu CMS tidak otomatis dipublikasikan hanya karena backend siap; perubahan website memiliki PR tersendiri karena merge website memicu deployment GitHub Pages.

## 8. Backup, rotasi dan rollback

Sebelum update, backup schema member_network dan encryption key terpisah. Jangan mengubah SQL dengan checksum yang sudah diterapkan. Tambahkan upgrade baru pada daftar versioned runner.

Rotasi terkontrol: hentikan service, isi kunci baru pada TOKEN_ENCRYPTION_KEY dan kunci lama pada TOKEN_ENCRYPTION_PREVIOUS_KEYS (maksimal tiga), jalankan `npm run db:rotate-key`, lalu start dan verifikasi. Rotasi transaksi mencakup koneksi OAuth dan credential sesi admin. Kode bisa membaca ciphertext legacy serta versi keyring baru. Jangan membuang kunci lama sebelum semua credential dan backup yang diperlukan sudah ditangani. Tidak ada secret yang dicetak skrip rotasi.

Retensi: state/sesi expired dibersihkan, audit dan job terminal lebih dari 90 hari dihapus, consent expired lama tanpa job dibersihkan, akun disconnect lebih dari 90 hari dianonimkan setelah ciphertext token sudah terhapus. Permintaan penghapusan eksplisit dianonimkan segera sesudah revoke sukses. Identifier acak internal tetap dipakai untuk integritas relasi; tidak ada Discord ID atau username asli setelah anonimisasi.

Rollback: matikan auto-join, hentikan service, kembali ke source/artifact sebelumnya yang kompatibel dengan schema. Jangan menjalankan DROP schema saat rollback. Restore backup harus tetap menahan auto-join sampai consent yang dicabut dan job yang mungkin sudah terkirim direkonsiliasi.

## Status kesiapan

Source, Node entry point, database upgrades/provisioning, preflight, cleanup, rotation, Docker alternatif, CI, dan artifact Wispbyte disiapkan. PostgreSQL lokal nyata, browser dengan upstream tiruan dan image container diuji. Ini belum membuktikan konfigurasi akun Wispbyte/Discord/Supabase produksi; subdomain aktual, secret, izin guild, live OAuth dan live join tetap merupakan gate aktivasi.
