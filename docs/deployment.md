# Deployment dan maintenance

> Target hosting yang dipilih adalah Wispbyte. Ikuti [panduan Wispbyte](wispbyte.md) sebagai runbook terbaru; bagian di bawah menyimpan konteks MVP awal, termasuk beberapa keterbatasan yang sudah ditangani pada readiness update.

## 1. Application Discord terpisah

1. Buka Discord Developer Portal, buat application **Vanillate Member Network**, lalu buat botnya. Jangan memakai application atau token bot utama.
2. Salin Application/Client ID, Client Secret dan Bot Token ke secret backend. Jangan kirim secret melalui chat, browser CMS, commit atau log.
3. OAuth2 Redirects: daftarkan URL HTTPS exact `https://HOST-API/auth/discord/callback`. Isi nilai yang sama pada DISCORD_REDIRECT_URI dan APP_BASE_URL dengan origin host tersebut.
4. Install bot ke server uji menggunakan scope `bot applications.commands` dan permission **Create Instant Invite** (nilai permission 1). Scope OAuth pengguna terpisah: `identify guilds.join`. Aplikasi tidak memerlukan Message Content atau Server Members Intent untuk auto-join REST ini. Tidak ada slash command pengelolaan; panel admin menjadi pusat konfigurasi campaign.
5. Backend mengecek identitas application dari bot saat startup. Discord Add Guild Member memerlukan bot pada server tujuan, permission Create Instant Invite, dan access token pengguna untuk application yang sama.
6. Uji akun cadangan yang memberi consent ke komunitas tujuan. Server dengan Membership Screening tetap meminta pengguna menyelesaikan screening; aplikasi mencatat `pending`.

Referensi resmi yang diperiksa: [Add Guild Member](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx#add-guild-member), [OAuth2](https://docs.discord.com/developers/topics/oauth2), [Supabase Auth getUser](https://supabase.com/docs/reference/javascript/auth-getuser), [Supabase changelog](https://supabase.com/changelog?tags=auth).

## 2. Database existing

Gunakan PostgreSQL proyek CMS existing yang telah diaudit, bukan database pemain. Jangan membuat proyek baru otomatis. Ambil backup sebelum perubahan produksi. DATABASE_URL menggunakan koneksi langsung/session pooler yang mendukung transaksi dan advisory lock, dengan TLS dan verifikasi sertifikat sesuai dokumentasi host.

`npm run db:migrate` menerapkan `db/schema.sql` dalam transaksi dengan advisory lock dan mencatat checksum awal di `member_network.schema_versions`. Menjalankannya kembali memverifikasi checksum. Setelah diterapkan, jangan mengubah berkas schema awal; tambahkan upgrade SQL tersendiri dan perluas runner secara eksplisit. Runner tidak menyentuh tabel `public` atau skema gameplay.

Schema `member_network` tidak boleh diekspos di Supabase Data API. RLS aktif, akses PUBLIC/anon/authenticated ditutup, tanpa policy browser. Jalur aplikasi memakai SQL backend parameterized. Untuk produksi, operator sebaiknya memisahkan role migrasi dari role runtime dan memberi role runtime hanya USAGE schema serta SELECT/INSERT/UPDATE/DELETE tabel layanan. Karena RLS tanpa policy, role runtime khusus membutuhkan policy khusus role backend atau BYPASSRLS terbatas dengan grants hanya schema layanan; jangan memakai role browser. Uji konfigurasi role dan grants aktual sebelum aktivasi. Jangan menggunakan role khusus ini untuk data CMS lain.

Supabase CLI pada workspace pembangunan tidak berhasil membuat migration karena keterbatasan filesystem/tooling. Sebagai alternatif yang dapat dijalankan, repo menyediakan bootstrap SQL dan runner checksum mandiri. Ini bukan klaim bahwa history Supabase migration sudah disinkronkan. Bila organisasi memakai Supabase CLI sebagai otoritas migration, impor bootstrap melalui workflow migration yang berlaku setelah review.

## 3. Environment backend

Salin `.env.example` dan isi hanya pada host. Nilai rahasia contoh sengaja kosong.

| Variabel                                  | Peran                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| DATABASE_URL                              | Koneksi PostgreSQL backend                                              |
| SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY    | Supabase Auth CMS existing, URL HTTPS dan key publik                    |
| ADMIN_USER_IDS, VIEWER_USER_IDS           | UUID Supabase Auth yang diberi akses admin atau baca agregat            |
| DISCORD_APPLICATION_ID, DISCORD_CLIENT_ID | ID application baru, harus sama                                         |
| DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN  | Rahasia backend                                                         |
| DISCORD_REDIRECT_URI                      | Callback HTTPS exact                                                    |
| APP_BASE_URL                              | Origin HTTPS aplikasi, tanpa path tambahan                              |
| TOKEN_ENCRYPTION_KEY                      | 32 byte acak, format 64 digit hex                                       |
| CMS_ORIGIN                                | Opsional, exact origin website CMS yang memanggil API dengan bearer JWT |
| AUTO_JOIN_ENABLED                         | Default false, operator mengaktifkan setelah acceptance test            |
| PORT, NODE_ENV                            | Port host dan production                                                |

Kunci acak dapat dibuat di host menggunakan `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Simpan hasil di secret manager. Jangan mencatatnya ke laporan.

SUPABASE_SERVICE_ROLE_KEY dan DISCORD_PUBLIC_KEY disediakan sebagai field kosong untuk kompatibilitas brief, tetapi **tidak diperlukan** implementasi ini. Database diakses langsung oleh backend. Public Key baru diperlukan bila kelak menambahkan HTTP interaction signatures. Jangan memasukkan rahasia yang tidak digunakan.

Ciphertext memakai satu kunci runtime dan AAD per member. Rotasi kunci saat ini memerlukan maintenance terkontrol: hentikan worker, backup terenkripsi, re-encrypt seluruh koneksi dan sesi admin dengan kunci lama dan baru menggunakan alat operator, verifikasi, lalu ganti secret. Rotasi multikey otomatis belum diimplementasikan. Kehilangan kunci berarti anggota harus menyambungkan ulang akun; jangan menghapus key lama sebelum backup dan rotasi selesai.

## 4. Menjalankan di host

Build image dari Dockerfile atau gunakan Node.js 24 dan `npm ci --omit=dev`. Jalankan sebagai user non-root dengan nama service/PM2 berbeda dari bot utama. Gunakan reverse proxy TLS; jangan membuka port database atau file .env. Docker image menyediakan healthcheck `/health/ready`.

Mulai dengan **satu proses API/worker** dan satu replika. Klaim DB mencegah pengambilan job sama, tetapi rate limit HTTP berada di memori per proses dan kendali Discord global bukan distributed scheduler penuh. Jangan menambah replika sebelum memakai limiter terpusat dan pengujian konkurensi PostgreSQL nyata. Proxy tidak dipercaya secara bawaan, sehingga reverse proxy berbagi bucket IP; atur limit/proxy secara terkontrol untuk volume produksi.

Worker berjalan sebagai bagian service Node mandiri ini, memakai REST bot account. Tidak ada proses Gateway yang membuat bot terlihat online atau slash command baru. Ini cukup untuk auto-join resmi dan sengaja menghindari intent serta koneksi yang belum diperlukan.

## 5. Acceptance test sebelum aktivasi

- Login akun allowlist dan viewer; pengguna lain, JWT palsu, sesi kedaluwarsa dan mutasi viewer ditolak.
- Daftarkan komunitas server uji dengan bot baru terpasang, setujui, lalu hubungkan Discord dari katalog.
- Pendaftaran tidak menjalankan join. Beri consent per komunitas, buat campaign pada komunitas tersebut, aktifkan AUTO_JOIN_ENABLED di host dan mulai campaign.
- Verifikasi masuk benar-benar terjadi. Uji existing member, screening pending, bot hilang/izin kurang, akun banned, token revoked dan rate limit.
- Cabut consent sebelum job berjalan dan pastikan tidak ditambahkan. Reconnect tidak memulihkan izin lama. Consent dipakai satu kali, campaign lain tidak boleh mengulangnya.
- Restart saat job berjalan, pastikan hasil ambigu menjadi unknown. Jangan menandai unknown sebagai konversi tanpa rekonsiliasi manual.
- Uji URL HTTPS callback, cookie Secure/HttpOnly, TLS database, healthcheck, backup dan restore pada host sebenarnya.

## 6. Maintenance dan pemulihan

Jadwalkan `npm run db:cleanup` sekali sehari dari host. Perintah menghapus state/sesi kedaluwarsa, audit lebih dari 90 hari, menyelesaikan campaign berakhir dan membatalkan antrean yang tertutup. Riwayat job/member belum dipurge otomatis; tetapkan kebijakan retensi dan prosedur penghapusan identitas sebelum membuka layanan publik berskala besar.

Tanpa pekerjaan aktif, worker tidak melakukan polling cepat; fallback maksimum 15 menit. Saat job aktif, satu job per siklus dan jeda minimum 1,5 detik. Retry rate limit maksimal lima upaya. Ciphertext koneksi yang dicabut ditahan hanya untuk retry revoke, lalu dihapus setelah sukses. Bila Discord terus gagal, monitor revoke_pending dan tangani melalui operator. Status lokal segera melarang join.

Untuk rollback aplikasi: matikan AUTO_JOIN_ENABLED, hentikan service baru, kembali ke image/commit sebelumnya. Biarkan schema aditif agar tidak kehilangan consent/audit. Tidak ada skrip DROP otomatis. Untuk restore: backup database dan encryption key secara terpisah, restore ke lingkungan isolasi, jangan mengaktifkan job dari backup sebelum merekonsiliasi pencabutan consent dan hasil join terbaru. Database dan Discord tidak berbagi transaksi.

Log runtime sengaja minimum dan tidak memuat raw SQL, body upstream, cookie, OAuth code atau token. Pantau audit, antrean unknown/failed, revoke_pending, healthcheck, storage dan egress. Analitik membaca agregat sesuai permintaan, tanpa snapshot push ke CMS lama.
