# Laporan perkembangan Member Network

## Implementasi MVP, 16 November 2026

Kode backend, UI anggota/admin, worker bot REST, database bootstrap, adapter CMS dan dokumentasi deployment tersedia. Rancangan Stage1 dilanjutkan dengan scope `identify guilds.join` sesuai koreksi pemilik.

Implementasi dan perbedaan terhadap rancangan awal: `docs/implementation.md`. Konfigurasi dan acceptance test host: `docs/deployment.md`. API dan adapter CMS: `docs/api.md`.

## Verifikasi lokal

Pemeriksaan sintaks, tes API/database/worker/upstream dengan PGlite dan layanan eksternal tiruan, serta browser desktop/mobile dijalankan. Run penuh 22 tes lolos, ditambah tes regresi penutupan campaign. Pemeriksaan browser desktop/mobile lolos. Audit dependency produksi melaporkan nol kerentanan. Hasil final juga dicatat di PR. Tidak ada produksi yang disentuh. Pengujian browser mencakup alur admin dan member sampai hasil auto-join tiruan serta pencabutan consent.

## Readiness Wispbyte

Tersedia entry point index.js, fallback SERVER_PORT, preflight offline/online, migration upgrade immutable, provisioning role database terbatas, keyring/rotasi, retensi otomatis harian dan penghapusan identitas setelah revoke. CI juga menyiapkan artifact upload Wispbyte dan menguji PostgreSQL nyata, browser serta image non-root. Bug wake worker saat sedang sibuk telah diperbaiki dan diuji regresi.

## Gate aktivasi yang membutuhkan akun host

- Buat Discord Application baru dan masukkan secret ke host, bukan chat/repository.
- Pilih Node.js 24 pada server Wispbyte terpisah, tentukan primary port dan subdomain HTTPS aktual.
- Backup, jalankan migrasi/provisioning dengan koneksi admin, lalu gunakan role runtime terbatas di host. Belum ada perubahan database produksi.
- Isi UUID allowlist dan jalankan preflight pada host; uji OAuth/join live di server uji sebelum mengaktifkan auto-join.
- Integrasi CMS existing disiapkan sebagai PR website tersendiri; URL publik backend belum dapat diisi sebelum subdomain ditentukan. Merge website memicu publikasi, sehingga tidak dilakukan sebagai bagian readiness.

## Batas yang tetap berlaku

Jalankan satu replika. Portal registrasi admin server umum dan observasi Gateway tidak termasuk release ini. Screening pending/hasil unknown tidak otomatis dianggap konversi. Tidak ada deployment produksi atau klaim live acceptance telah lolos.
