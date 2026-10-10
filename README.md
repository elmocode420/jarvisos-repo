# JarvisOS

Asistente personal de voz. Te **llama** (como una llamada en tu celular) para recordatorios y reuniones,
y puedes **hablar con él** para gestionar tareas, agenda y progreso.

- `/` — llamadas de voz internas entre usuarios (WebRTC, gratis).
- `/assistant.html` — Jarvis (PWA para el celular).

## Arranque (en tu PC)

```bash
npm install
cp .env.example .env     # rellena ANTHROPIC_API_KEY, ACCESS_TOKEN, OWNER_NAME, TZ
npm start
```

### Voz con Piper (gratis, local)

1. Instala Piper y descarga una voz en español (`.onnx` + `.onnx.json`) en `voices/`.
2. Pon `PIPER_MODEL=voices/<tu-voz>.onnx` (y `PIPER_BIN` si `piper` no está en el PATH) en `.env`.

Sin Piper, la app usa la voz del navegador como respaldo.

### Usarlo desde el celular

El micrófono y las notificaciones exigen **HTTPS**. Con tu PC encendida, expón el puerto con un túnel gratis
(`cloudflared tunnel --url http://localhost:3000`) o Tailscale, y abre en el celular
`https://<tu-túnel>/assistant.html#<ACCESS_TOKEN>`. Luego "Añadir a pantalla de inicio" e instálala.

## Qué hace hoy

- Recordatorios y reuniones: a la hora te llama; si no contestas, reintenta 2 veces cada 5 min.
- Tareas, agenda y reporte de progreso por voz (Claude con herramientas sobre `data/db.json`).
- Límites conocidos: la PWA debe estar abierta para que suene (sin Web Push aún); el reconocimiento de voz es el
  del navegador (Chrome/Android); sin llamadas a la red telefónica real ni filtrado de llamadas entrantes (siguiente etapa).
