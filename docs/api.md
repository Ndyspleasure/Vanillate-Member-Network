# API dan integrasi CMS

Semua endpoint JSON memakai `/api`. Mutasi memerlukan `Origin` exact APP_BASE_URL atau CMS_ORIGIN. List memakai cursor UUID `after`, `limit` default 25 maksimum 100. Error mengandung pesan aman dan request_id, tanpa SQL/token.

## Anggota dan publik

| Method        | Path                                | Hasil                                              |
| ------------- | ----------------------------------- | -------------------------------------------------- |
| GET           | /api/catalog?language=id&tag=gaming | Komunitas approved saja, items dan next            |
| GET           | /auth/discord/start                 | Memulai OAuth, state terikat cookie                |
| GET           | /auth/discord/callback              | Menyelesaikan OAuth dan sesi anggota               |
| GET           | /api/me                             | Profil sendiri dan consent aktif                   |
| PATCH         | /api/me/interests                   | Body interests, array maksimal 10                  |
| GET           | /api/me/recommendations             | Maksimal 25 rekomendasi dan alasan minat           |
| GET           | /api/me/activity                    | Maksimal 50 hasil job milik sendiri                |
| POST / DELETE | /api/me/consents/:communityId       | Beri/cabut izin 30 hari per komunitas              |
| POST          | /api/me/disconnect                  | Batalkan job, cabut consent, antrikan revoke token |

Sesi anggota hanya HttpOnly, tidak dikirim pada response JSON. Persetujuan digunakan satu kali. Rekomendasi bukan bukti pengguna belum berada di guild; Discord join mengembalikan already_member bila sudah bergabung.

## Admin

Login panel menggunakan POST /auth/admin/login dengan email/password CMS, lalu cookie HttpOnly yang berlaku maksimum satu jam. POST /auth/logout menghapus sesi server. Login MFA/passkey/Social Login tidak dibuat ulang di panel ini; akun yang memakai metode tersebut dapat memakai sesi CMS melalui bearer API.

API admin juga menerima `Authorization: Bearer <Supabase CMS access token>`. Backend selalu memverifikasi token lewat Auth `/user`, lalu memeriksa UUID pada allowlist server. Jangan menerima role dari payload browser atau user_metadata. Viewer boleh membaca komunitas/campaign dan analitik agregat; tidak boleh melihat identitas anggota, audit atau detail job.

| Method     | Path                                        | Akses                           |
| ---------- | ------------------------------------------- | ------------------------------- |
| GET        | /api/admin/session                          | Admin/viewer                    |
| GET        | /api/admin/members                          | Admin                           |
| PATCH      | /api/admin/members/:id, body active boolean | Admin                           |
| POST       | /api/admin/members/:id/disconnect           | Admin                           |
| GET        | /api/admin/members/:id/activity             | Admin                           |
| GET / POST | /api/admin/communities                      | Baca admin/viewer, tulis admin  |
| PATCH      | /api/admin/communities/:id, body status     | Admin                           |
| GET / POST | /api/admin/campaigns                        | Baca admin/viewer, tulis admin  |
| POST       | /api/admin/campaigns/:id/start              | Admin, auto-join harus aktif    |
| POST       | /api/admin/campaigns/:id/pause              | Admin                           |
| POST       | /api/admin/campaigns/:id/complete           | Admin, batalkan antrean tersisa |
| GET        | /api/admin/campaigns/:id/jobs               | Admin, daftar hasil dipaginasi  |
| GET        | /api/admin/analytics                        | Admin/viewer, agregat 30 hari   |
| GET        | /api/admin/audit                            | Admin, maksimal 100 aktivitas   |

Community POST: guild_id, name, description, language, tags. Komunitas dibuat pending; operator admin CMS bertanggung jawab mendaftarkan server yang berhak dikelola. Backend memverifikasi bot dapat mengakses guild. Portal self-service admin server dan verifikasi izin Discord individu belum tersedia, sehingga tidak boleh membuka operasi ini untuk pendaftar umum.

Campaign POST: community_id, name, limit 1 sampai 1000, tags, starts_at/ends_at ISO datetime dengan timezone. Target hanya anggota aktif yang memiliki consent exact komunitas dan cocok tags. Tombol start dapat dipanggil lagi tanpa menduplikasi anggota/consent atau melampaui batas campaign. Anggota baru tidak otomatis ditambahkan ke campaign yang sudah berjalan sampai admin menekan start lagi.

## Website CMS existing

`integrations/cms-client.js` menyediakan adapter yang menerima klien Supabase CMS existing. Isi CMS_ORIGIN di backend dan gunakan URL API tetap dari konfigurasi publik. Jangan menyalin secret bot, DATABASE_URL atau encryption key ke website.

```js
import { memberNetworkClient } from "./member-network-client.js";
const request = memberNetworkClient(
  configuredApiOrigin,
  existingCmsSupabaseClient,
);
const stats = await request("/api/admin/analytics");
```

Adapter membatasi path admin, menggunakan bearer JWT, dan tidak mengirim cookie lintas origin. Salin adapter ke repo website sesuai struktur CMS saat mengerjakan integrasi menu/halaman existing. Panel lengkap juga dapat dibuka melalui tautan ke URL `/admin` pada aplikasi ini. Repo website existing belum diubah pada implementasi ini; adapter bukan klaim menu CMS sudah terpasang di produksi.

Health: GET /health/live dan /health/ready. Endpoint readiness memeriksa schema database, tidak menampilkan identitas host atau kredensial.
