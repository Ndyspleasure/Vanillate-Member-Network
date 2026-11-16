# Laporan perkembangan Member Network

## Implementasi MVP, 16 November 2026

Kode backend, UI anggota/admin, worker bot REST, database bootstrap, adapter CMS dan dokumentasi deployment tersedia. Rancangan Stage1 dilanjutkan dengan scope `identify guilds.join` sesuai koreksi pemilik.

Implementasi dan perbedaan terhadap rancangan awal: `docs/implementation.md`. Konfigurasi dan acceptance test host: `docs/deployment.md`. API dan adapter CMS: `docs/api.md`.

## Verifikasi lokal

Pemeriksaan sintaks, tes API/database/worker/upstream dengan PGlite dan layanan eksternal tiruan, serta browser desktop/mobile dijalankan. Run penuh 22 tes lolos, ditambah tes regresi penutupan campaign. Pemeriksaan browser desktop/mobile lolos. Audit dependency produksi melaporkan nol kerentanan. Hasil final juga dicatat di PR. Tidak ada produksi yang disentuh. Pengujian browser mencakup alur admin dan member sampai hasil auto-join tiruan serta pencabutan consent.

## Pekerjaan terbuka

- MN-001: Operator membuat Discord Application baru dan memasukkan secret hanya ke host backend. Verifikasi bot, permission dan OAuth callback live pada test guild.
- MN-002: Review bootstrap SQL, backup dan jalankan migrasi secara eksplisit pada database CMS existing. Uji TLS dan role runtime terbatas; belum ada migrasi produksi.
- MN-003: Pasang service mandiri, origin HTTPS, UUID allowlist dan cleanup harian. Auto-join bawaan mati sampai acceptance test selesai.
- MN-004: Integrasi menu/halaman website CMS existing memerlukan perubahan repo website terpisah. Adapter API tersedia, panel admin layanan ini sudah ada.
- MN-005: Portal mandiri untuk admin server umum, verifikasi izin individu Discord, retensi/penghapusan data member/job, multikey rotation, observasi membership dan rekonsiliasi hasil unknown belum tersedia. Jangan mengklaim fitur ini selesai.
- MN-006: Sebelum menambah replika, uji PostgreSQL nyata, distributed rate limiting dan konkurensi. Tes PGlite tidak menggantikan uji tersebut.
