# HANDCAP - WhatsApp API Gateway MVP (Self-Hosted)

HANDCAP adalah microservice API Gateway WhatsApp mandiri (self-hosted) berbasis Node.js yang ringan dan efisien. Layanan ini dirancang khusus untuk memungkinkan website atau aplikasi lain mengirim pesan/OTP menggunakan WhatsApp personal secara gratis tanpa membayar biaya per-pesan ke Meta.

## Fitur Utama MVP
1. **Multi-Device Session Manager:** Mendukung login nomor WhatsApp menggunakan metode scan QR Code.
2. **REST API Endpoint:** Mengirim pesan teks otomatis melalui request HTTP POST sederhana.
3. **Real-time QR Code Streaming:** Menampilkan QR Code secara real-time di dashboard web saat menghubungkan nomor WA baru menggunakan WebSockets.
4. **Lightweight & High Performance:** Menggunakan library `@whiskeysockets/baileys` yang tidak membutuhkan Chromium/Puppeteer sehingga sangat hemat RAM (~30-50MB per nomor).
5. **Auto-Reconnect:** Sistem otomatis mencoba menghubungkan kembali koneksi jika koneksi internet terputus.

---

## Struktur Folder Proyek
```text
handcap/
├── sessions/               # Folder tempat menyimpan data autentikasi WA (creds)
├── src/
│   ├── routes/
│   │   └── api.js          # Route Express untuk endpoint kirim pesan
│   ├── db.js               # Konfigurasi koneksi Database (MySQL)
│   ├── sessionManager.js   # Logic utama penghubung Baileys WhatsApp
│   └── index.js            # Entry point utama aplikasi (Express & Socket.io)
├── .env.example            # Contoh konfigurasi environment
├── package.json            # Daftar dependencies proyek
└── README.md               # Dokumentasi proyek ini
```

---

## Prasyarat & Cara Menjalankan

### 1. Instalasi Node.js
Pastikan Anda sudah menginstal Node.js versi 18 atau yang lebih baru di server/komputer Anda.

### 2. Instalasi Dependencies
Buka terminal di folder proyek ini dan jalankan:
```bash
npm install
```

### 3. Konfigurasi Environment (`.env`)
Buat file bernama `.env` di root folder dan isi dengan konfigurasi berikut:
```env
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=handcap_db
DB_PORT=3306
```

### 4. Menjalankan Aplikasi
* **Mode Development (Auto-Reload):**
  ```bash
  npm run dev
  ```
* **Mode Production:**
  ```bash
  npm start
  ```

---

## Rancangan Teknis & API Spec

### 1. Endpoint Kirim Pesan
* **URL:** `POST /api/v1/send-message`
* **Headers:**
  * `Content-Type: application/json`
  * `Authorization: Bearer <API_KEY>`
* **Request Body:**
  ```json
  {
    "phone": "628123456789",
    "message": "Halo! Ini adalah kode OTP Anda: 994821"
  }
  ```
* **Response (Success):**
  ```json
  {
    "status": "success",
    "message": "Message sent successfully",
    "data": {
      "id": "MSG_ID_12345",
      "recipient": "628123456789"
    }
  }
  ```

---

## Panduan AI untuk Mengembangkan Kode (Prompt Generator)
Jika Anda ingin mengirimkan instruksi ini ke AI lain (atau melanjutkan pengembangan bersama saya), Anda bisa menggunakan prompt di bawah ini:

> "Saya ingin membuat aplikasi WhatsApp API Gateway bernama HANDCAP menggunakan Node.js dan library `@whiskeysockets/baileys`. 
> Tolong bantu saya mengimplementasikan kode untuk:
> 1. `src/sessionManager.js` yang bertugas untuk menginisialisasi koneksi WhatsApp, menyimpan data sesi ke folder `./sessions`, memantau status koneksi, dan menyediakan fungsi mengirim pesan.
> 2. `src/index.js` yang menggabungkan server Express API dengan Socket.io agar bisa mengirimkan QR Code secara real-time ke client saat user memanggil proses login.
> 3. `src/routes/api.js` untuk meng-handle endpoint `POST /api/v1/send-message` dengan melakukan validasi nomor telepon dan memanggil fungsi kirim pesan dari sessionManager."
