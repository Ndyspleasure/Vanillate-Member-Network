# Laporan perkembangan Vanillate Member Network

## Stage 1. 16 November 2026

Audit repository dan metadata Supabase CMS serta rancangan tersedia di `docs/stage-1-architecture.md`. Status dokumentasi saja. Belum ada runtime, migration, Discord Application baru, atau integrasi yang telah diuji. Koreksi pemilik: `guilds.join` diperbolehkan.

## Pekerjaan terbuka

- MN-001: Tinjau rancangan dan tetapkan model persetujuan auto-join, host dan anggaran kuota. Default rancangan persetujuan per komunitas.
- MN-002: Sebelum implementasi, selesaikan pembacaan penuh bagian CLAUDE.md/claudereport.md bot yang keluaran alatnya terpotong; jangan mengklaim audit instruksi baris demi baris lengkap.
- MN-003: Verifikasi dokumentasi resmi OAuth2/Add Guild Member dan Supabase terkini. Fetch changelog mendapat 403, dua path raw Discord mendapat 404.
- MN-004: Tinjau dan verifikasi otorisasi CMS di lingkungan terisolasi sebelum aktivasi fitur sensitif. Detail audit keamanan disimpan dalam catatan internal.
- MN-005: Stage 2 sampai 6 belum dimulai. Gunakan matriks penerimaan dalam dokumen arsitektur dan laporkan bukti aktual tiap tahap.
