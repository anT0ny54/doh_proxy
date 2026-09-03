import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Memastikan kompresi berjalan di tingkat aplikasi jika CDN platform melewatkannya
  compress: true,
  // Mengizinkan konfigurasi eksternal netlify/vercel mendeteksi aset dengan benar
  poweredByHeader: false,
  // Membantu optimasi image (jika UI menggunakan komponen Image Next)
  images: {
    unoptimized: true, // Optimal untuk deployment statis / serverless multi-platform
  },
};

export default nextConfig;
