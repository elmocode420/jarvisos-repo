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

### Usarlo desde el celular (no hay que descargar nada de una tienda)

Es una página web que se instala desde el navegador (PWA):

1. El micrófono y los avisos exigen **HTTPS**. Con tu PC encendida, expón el puerto con un túnel gratis
   (`cloudflared tunnel --url http://localhost:3000`) o Tailscale.
2. En el celular abre `https://<tu-túnel>/assistant.html#<ACCESS_TOKEN>`.
3. Instálala: en Android/Chrome menú ⋮ → "Instalar app"; en iPhone/Safari Compartir → "Añadir a pantalla de inicio"
   (iOS 16.4+ y solo recibe avisos si la abres desde ese icono).
4. Abre la app, toca **Activar** y acepta las notificaciones. Desde ahí, Jarvis te avisa con **Web Push** aunque la app esté cerrada;
   al tocar el aviso se abre la llamada.

Las claves VAPID se generan solas en `data/vapid.json`. Pon tu correo en `VAPID_SUBJECT` (formato `mailto:tu@correo`).
Si borras `data/`, hay que volver a tocar **Activar** en el celular.

## Qué hace hoy

- Recordatorios y reuniones: a la hora te llama; si no contestas, reintenta 2 veces cada 5 min.
- Tareas, agenda y reporte de progreso por voz (Claude con herramientas sobre `data/db.json`).
- Aviso con la app cerrada (Web Push). El timbre y la conversación ocurren al abrir la app desde el aviso.
- Límites conocidos: el reconocimiento de voz es el
  del navegador (Chrome/Android); sin llamadas a la red telefónica real ni filtrado de llamadas entrantes (siguiente etapa).
