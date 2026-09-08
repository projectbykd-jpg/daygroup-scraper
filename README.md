# daygroup-scraper

Scraper **Laporan Harian → Lap Admin** untuk [Day-Group Panel](https://panel-worker.projectbykd.workers.dev).

Jalan di **GitHub Actions** (VM Linux, tanpa batas subrequest seperti Cloudflare
Workers), dipicu oleh panel via GitHub API. Repo ini **publik** supaya menit
Actions gratis tanpa batas — dan **tidak menyimpan rahasia apa pun**: kredensial
admin (link + cookie `PHPSESSID`) diambil saat runtime lewat callback ke panel
memakai token sekali-pakai.

## Alur

```
Panel klik START (Lap Admin)
  → Worker buat job di D1 + panggil GitHub API (workflow_dispatch)
       inputs: job_id, callback (URL panel), key (token sekali-pakai)
  → Actions: node scrape.mjs
       1. POST {action:lapJobStart}  → ambil {creds, params}, job jadi 'running'
       2. scrape Register + Report Agent + Check Koin + Withdraw PGA-IDF
       3. POST {action:lapJobResult} → hasil disimpan ke D1, job 'done'
  → Panel poll lapJobStatus → render tabel
```

## Setup (sekali)

1. Repo ini **Public**.
2. Di panel-worker: `wrangler secret put GH_TOKEN` — fine-grained PAT,
   akses **repo `daygroup-scraper`**, permission **Actions: Read and write**.
3. Isi Link + Cookie Admin di menu **Laporan Harian → Setting**.

Tidak ada dependency npm — `scrape.mjs` pakai `fetch` bawaan Node 20.
